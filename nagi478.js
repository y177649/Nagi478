/**
 * Nagi478 — 4-7-8 呼吸法 UI
 *
 * ブロック概要（PR / リファクタ用）
 * 1) セッション … start / pause / resume / stop / 完了（pause は master 0.8s フェード→suspend、resume はフェードイン）
 * 2) 呼吸サイクル … runCycle, scheduleBeats, complete
 * 3) 表示更新 … setPhase, pulseVisual, updateTimer
 * 4) オーディオ … 定位 / 和音 / 背景ノイズ
 * 5) 静寂（暗転）… 1分で enter、タップで解除、無操作再暗転
 * 6) ユーティリティ … schedule
 */
(() => {
  'use strict';

  class BreathingApp {
    // ————————————————————————————————————————————————
    // 初期化 & DOM 参照
    // ————————————————————————————————————————————————
    constructor() {
      this.audioCtx = null;
      this.masterGain = null;
      this.isRunning = false;
      this.isPaused = false;
      this.timers = [];
      this.startTime = 0;
      this.totalDuration = 0;
      this.timerInterval = null;
      this._oneMinMilestoneDone = false;
      this._pauseBegan = 0;
      this._pauseFadeSuspendTimer = null;
      this._masterLevelBeforePauseFade = null;

      // フェーズ長さ (ms)
      this.INHALE = 4000;
      this.HOLD = 7000;
      this.EXHALE = 8000;
      this.CYCLE = this.INHALE + this.HOLD + this.EXHALE;

      // 拍（全て1秒。切替音と重ならないよう 500ms から）
      this.inhaleIntervals = [1000, 1000, 1000, 1000];
      this.holdIntervals = [1000, 1000, 1000, 1000, 1000, 1000, 1000];
      this.exhaleIntervals = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000];

      this.els = {
        controls: document.getElementById('controls'),
        startBtn: document.getElementById('startBtn'),
        selectedDuration: document.getElementById('selectedDuration'),
        minutesInput: document.getElementById('minutesInput'),
        phaseLabel: document.getElementById('phaseLabel'),
        phaseEn: document.getElementById('phaseEn'),
        timeRemaining: document.getElementById('timeRemaining'),
        sessionActions: document.getElementById('sessionActions'),
        pauseBtn: document.getElementById('pauseBtn'),
        stopBtn: document.getElementById('stopBtn'),
        circle: document.getElementById('breathCircle'),
        visual: document.getElementById('breathVisual'),
        positionGuide: document.getElementById('positionGuide'),
        positionItems: document.querySelectorAll('.position-item'),
        dimOverlay: document.getElementById('dimOverlay'),
        eyesMessage: document.getElementById('eyesMessage')
      };

      this.panWidth = 0.6;
      this.quietExited = false;

      this._idleReDimArmed = false;
      this._idleReDimTimer = null;
      this._idleReDimBound = false;
      this._onIdleReDimUserAction = (e) => {
        if (!this._idleReDimArmed || !this.isRunning) return;
        if (this.els.dimOverlay.classList.contains('active')) return;
        this.bumpIdleReDim();
      };

      this.els.startBtn.addEventListener('click', () => this.onStartClick());
      this.els.pauseBtn.addEventListener('click', () => this.onPauseResumeClick());
      this.els.stopBtn.addEventListener('click', () => this.onStopClick());
      this.els.minutesInput.addEventListener('change', () => this.onDurationSelect());

      this.els.dimOverlay.addEventListener('click', (e) => {
        e.preventDefault();
        this.onDimOverlayTap();
      });
      document.addEventListener('touchmove', (e) => {
        if (e.scale !== 1) e.preventDefault();
      }, { passive: false });
    }

    // ————————————————————————————————————————————————
    // 1. セッションライフサイクル
    // ————————————————————————————————————————————————
    /** 1–15 分を選ぶと duration 行を隠し Start のみ表示 */
    onDurationSelect() {
      const v = this.els.minutesInput.value;
      if (v === '' || v == null) return;
      this.els.controls.classList.add('start-revealed', 'duration-picked');
      this.els.selectedDuration.textContent = `${v} min`;
    }

    onStartClick() {
      if (this.isRunning || this.isPaused) return;
      void this.start().catch(() => {});
    }

    onPauseResumeClick() {
      if (this.isRunning) this.pause();
      else if (this.isPaused) void this.resume().catch(() => {});
    }

    onStopClick() {
      if (this.isRunning || this.isPaused) this.stop();
    }

    async start() {
      const minutes = Math.max(1, Math.min(15, parseInt(this.els.minutesInput.value, 10) || 0));
      if (!minutes) return;

      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        this.masterGain = this.audioCtx.createGain();
        this.masterGain.gain.value = 0.6;
        this.masterGain.connect(this.audioCtx.destination);
      }
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }

      this.startBackgroundNoise();
      this.resetQuietMode();

      this.masterGain.gain.cancelScheduledValues(this.audioCtx.currentTime);
      this.masterGain.gain.setValueAtTime(0.6, this.audioCtx.currentTime);

      this.totalDuration = minutes * 60 * 1000;
      this.startTime = performance.now();
      this._oneMinMilestoneDone = false;
      this.isRunning = true;
      this.isPaused = false;

      this.els.minutesInput.disabled = true;
      this.els.controls.classList.add('session-running');
      this.els.sessionActions.setAttribute('aria-hidden', 'false');
      this.els.pauseBtn.textContent = 'Pause';

      this.updateTimer();
      this.timerInterval = setInterval(() => this.updateTimer(), 250);

      setTimeout(() => {
        if (this.isRunning) this.runCycle();
      }, 1800);

      this._schedule1MinMilestones();
    }

    static get PAUSE_FADE_S() { return 0.8; }
    static get PAUSE_SUSPEND_MS() { return 900; }

    /**
     * 停止のノイズフェード同様: 全体をマスターで 0.8s 下げてから（任意で）suspend
     */
    _fadeOutMasterForPause(suspendWhenDone) {
      if (!this.audioCtx || !this.masterGain) return;
      const t = this.audioCtx.currentTime;
      this.masterGain.gain.cancelScheduledValues(t);
      this._masterLevelBeforePauseFade = this.masterGain.gain.value;
      this.masterGain.gain.setValueAtTime(this._masterLevelBeforePauseFade, t);
      this.masterGain.gain.linearRampToValueAtTime(0, t + BreathingApp.PAUSE_FADE_S);
      if (suspendWhenDone) {
        this._pauseFadeSuspendTimer = setTimeout(() => {
          this._pauseFadeSuspendTimer = null;
          if (this.isPaused && this.audioCtx) this.audioCtx.suspend();
        }, BreathingApp.PAUSE_SUSPEND_MS);
      }
    }

    _fadeInMasterFromPause() {
      if (!this.audioCtx || !this.masterGain) return;
      const t = this.audioCtx.currentTime;
      this.masterGain.gain.cancelScheduledValues(t);
      const target =
        this._masterLevelBeforePauseFade != null ? this._masterLevelBeforePauseFade : 0.6;
      const from = this.masterGain.gain.value;
      this.masterGain.gain.setValueAtTime(from, t);
      this.masterGain.gain.linearRampToValueAtTime(target, t + BreathingApp.PAUSE_FADE_S);
    }

    pause() {
      if (!this.isRunning) return;
      this.isRunning = false;
      this.isPaused = true;
      this._pauseBegan = performance.now();
      this.timers.forEach(clearTimeout);
      this.timers = [];
      if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }
      this._fadeOutMasterForPause(true);
      this.els.pauseBtn.textContent = 'Resume';
    }

    async resume() {
      if (!this.isPaused) return;
      if (this._pauseFadeSuspendTimer) {
        clearTimeout(this._pauseFadeSuspendTimer);
        this._pauseFadeSuspendTimer = null;
      }
      this.isPaused = false;
      this.isRunning = true;
      this.startTime += performance.now() - this._pauseBegan;
      if (this.audioCtx) {
        if (this.audioCtx.state === 'suspended') {
          try {
            await this.audioCtx.resume();
          } catch (e) { /* 無視 */ }
        }
        this._fadeInMasterFromPause();
      }
      this.updateTimer();
      this.timerInterval = setInterval(() => this.updateTimer(), 250);
      this._schedule1MinMilestones();
      setTimeout(() => {
        if (this.isRunning) this.runCycle();
      }, 400);
    }

    stop() {
      this.isRunning = false;
      this.isPaused = false;
      if (this._pauseFadeSuspendTimer) {
        clearTimeout(this._pauseFadeSuspendTimer);
        this._pauseFadeSuspendTimer = null;
      }
      this._masterLevelBeforePauseFade = null;
      this.timers.forEach(clearTimeout);
      this.timers = [];
      if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }
      this._oneMinMilestoneDone = true;

      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        try {
          this.audioCtx.resume();
        } catch (e) { /* 無視 */ }
      }
      if (this.audioCtx && this.masterGain) {
        const t = this.audioCtx.currentTime;
        this.masterGain.gain.cancelScheduledValues(t);
        this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, t);
      }
      this.stopBackgroundNoise();

      this.els.circle.classList.remove('inhale-anim', 'hold-anim', 'exhale-anim');
      this.els.circle.style.transition = 'transform 0.8s ease';
      this.els.circle.style.transform = 'scale(0.35)';
      setTimeout(() => {
        this.els.circle.style.transition = '';
        this.els.circle.style.transform = '';
      }, 900);

      this.setPhase('', '', false);
      this.resetQuietMode();
      this.els.minutesInput.disabled = false;
      this.els.controls.classList.remove('start-revealed', 'duration-picked', 'session-running');
      this.els.sessionActions.setAttribute('aria-hidden', 'true');
      this.els.pauseBtn.textContent = 'Pause';
      this.els.minutesInput.selectedIndex = 0;
      this.els.selectedDuration.textContent = '—';
      this.els.timeRemaining.textContent = '—';
    }

    // ————————————————————————————————————————————————
    // 2. 呼吸サイクル（4-7-8）
    // ————————————————————————————————————————————————
    runCycle() {
      if (!this.isRunning) return;

      const elapsed = performance.now() - this.startTime;
      if (elapsed >= this.totalDuration) {
        this.complete();
        return;
      }

      this.playTransition('inhale');
      this.setPhase('吸 　 う', 'inhale', true);
      this.els.circle.classList.remove('hold-anim', 'exhale-anim');
      void this.els.circle.offsetWidth;
      this.els.circle.classList.add('inhale-anim');
      this.scheduleBeats(this.inhaleIntervals, 0, 'inhale');

      this.schedule(() => {
        if (!this.isRunning) return;
        this.playTransition('hold');
        this.setPhase('止 め る', 'hold', true);
        this.els.circle.classList.remove('inhale-anim');
        this.els.circle.classList.add('hold-anim');
      }, this.INHALE);
      this.scheduleBeats(this.holdIntervals, this.INHALE, 'hold');

      this.schedule(() => {
        if (!this.isRunning) return;
        this.playTransition('exhale');
        this.setPhase('吐 　 く', 'exhale', true);
        this.els.circle.classList.remove('hold-anim');
        this.els.circle.classList.add('exhale-anim');
      }, this.INHALE + this.HOLD);
      this.scheduleBeats(this.exhaleIntervals, this.INHALE + this.HOLD, 'exhale');

      this.schedule(() => this.runCycle(), this.CYCLE);
    }

    scheduleBeats(intervals, offsetMs, phase) {
      let t = offsetMs + 500;
      const total = intervals.length;
      intervals.forEach((interval, i) => {
        const timeAtBeat = t;
        const idx = i;
        t += interval;
        this.schedule(() => {
          if (!this.isRunning) return;
          this.playBeat(phase, idx, total);
        }, timeAtBeat);
      });
    }

    complete() {
      this.els.timeRemaining.textContent = '0:00';
      this.setPhase('完　了', 'complete', true);

      if (this.audioCtx && this.masterGain) {
        const now = this.audioCtx.currentTime;
        this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
        this.masterGain.gain.linearRampToValueAtTime(0, now + 3);
      }

      setTimeout(() => {
        this.stop();
      }, 3200);
    }

    // ————————————————————————————————————————————————
    // 3. 表示（フェーズ文言・円の脈打ち・残り時間）
    // ————————————————————————————————————————————————
    setPhase(jp, en, visible) {
      this.els.phaseLabel.textContent = jp;
      this.els.phaseEn.textContent = en;
      if (visible) {
        this.els.phaseLabel.classList.add('visible');
        this.els.phaseEn.classList.add('visible');
      } else {
        this.els.phaseLabel.classList.remove('visible');
        this.els.phaseEn.classList.remove('visible');
      }
      this.els.positionItems.forEach(item => {
        if (item.dataset.phase === en) {
          item.classList.add('active');
        } else {
          item.classList.remove('active');
        }
      });
    }

    pulseVisual() {
      const ring = document.createElement('div');
      ring.className = 'pulse-ring active';
      this.els.visual.appendChild(ring);
      setTimeout(() => ring.remove(), 1100);
    }

    updateTimer() {
      if (!this.isRunning) return;
      const elapsed = performance.now() - this.startTime;
      const remaining = Math.max(0, this.totalDuration - elapsed);
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      this.els.timeRemaining.textContent =
        `${m}:${String(s).padStart(2, '0')}`;
    }

    // ————————————————————————————————————————————————
    // 4a. オーディオ：左右定位（L/C/R）
    // ————————————————————————————————————————————————
    getPhasePan(phase) {
      if (phase === 'inhale') return -this.panWidth;
      if (phase === 'exhale') return +this.panWidth;
      return 0;
    }

    _panToGains(pan, peakGain) {
      const leftGain  = pan >= 0 ? peakGain * (1 - pan) : peakGain;
      const rightGain = pan <= 0 ? peakGain * (1 + pan) : peakGain;
      return { leftGain, rightGain };
    }

    // ————————————————————————————————————————————————
    // 4b. オーディオ：拍・切替和音・単音
    // ————————————————————————————————————————————————
    playBeat(phase, index, total) {
      if (!this.audioCtx) return;
      const now = this.audioCtx.currentTime;

      const BINAURAL_DIFF = 10;
      const chord = [261.63, 329.63, 392.00];
      const decay = 1.6;
      const peakGain = 0.035;

      const pan = this.getPhasePan(phase);
      const { leftGain, rightGain } = this._panToGains(pan, peakGain);

      chord.forEach(freq => {
        this._playTone(freq, -1, leftGain, decay, now);
        this._playTone(freq + BINAURAL_DIFF, +1, rightGain, decay, now);
      });

      if (navigator.vibrate && phase !== 'prep') navigator.vibrate(30);
      if (phase !== 'prep') this.pulseVisual();
    }

    playTransition(phase) {
      if (!this.audioCtx || !this.isRunning) return;
      const now = this.audioCtx.currentTime;

      const BINAURAL_DIFF = 10;
      const chord = [392.00, 493.88, 587.33];
      const decay = 1.4;
      const peakGain = 0.045;

      const pan = this.getPhasePan(phase);
      const { leftGain, rightGain } = this._panToGains(pan, peakGain);

      chord.forEach(freq => {
        this._playTone(freq, -1, leftGain, decay, now);
        this._playTone(freq + BINAURAL_DIFF, +1, rightGain, decay, now);
      });

      if (navigator.vibrate) navigator.vibrate(20);
    }

    _playTone(freq, pan, peakGain, decay, t) {
      const ctx = this.audioCtx;

      const osc   = ctx.createOscillator();
      osc.type    = 'sine';
      osc.frequency.value = freq;

      const gain  = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(peakGain, t + 0.014);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);

      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;

      osc.connect(gain);
      gain.connect(panner);
      panner.connect(this.masterGain);
      osc.start(t);
      osc.stop(t + decay + 0.05);

      const harm = ctx.createOscillator();
      harm.type  = 'sine';
      harm.frequency.value = freq * 2.0;

      const hg   = ctx.createGain();
      hg.gain.setValueAtTime(0.0001, t);
      hg.gain.linearRampToValueAtTime(peakGain * 0.28, t + 0.014);
      hg.gain.exponentialRampToValueAtTime(0.0001, t + decay * 0.55);

      const hp   = ctx.createStereoPanner();
      hp.pan.value = pan;

      harm.connect(hg);
      hg.connect(hp);
      hp.connect(this.masterGain);
      harm.start(t);
      harm.stop(t + decay * 0.6);
    }

    // ————————————————————————————————————————————————
    // 4c. オーディオ：バイノーラル背景ノイズ
    // ————————————————————————————————————————————————
    startBackgroundNoise() {
      if (this.noiseNodes) return;
      const ctx = this.audioCtx;
      const sampleRate = ctx.sampleRate;
      const now = ctx.currentTime;

      const makeNoise = () => {
        const buf = ctx.createBuffer(1, sampleRate * 3, sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        return buf;
      };

      const sources = [];
      const gains = [];

      const setupChannel = (buffer, pan, binauralFreq) => {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;

        const lowpass = ctx.createBiquadFilter();
        lowpass.type = 'lowpass';
        lowpass.frequency.value = 2500;
        lowpass.Q.value = 0.7;

        const highpass = ctx.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = 120;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.055, now + 1.5);

        const panner = ctx.createStereoPanner();
        panner.pan.value = pan;

        src.connect(lowpass);
        lowpass.connect(highpass);
        highpass.connect(gain);
        gain.connect(panner);
        panner.connect(this.masterGain);
        src.start(now);

        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = binauralFreq;

        const oGain = ctx.createGain();
        oGain.gain.setValueAtTime(0, now);
        oGain.gain.linearRampToValueAtTime(0.025, now + 1.5);

        const oPan = ctx.createStereoPanner();
        oPan.pan.value = pan;

        osc.connect(oGain);
        oGain.connect(oPan);
        oPan.connect(this.masterGain);
        osc.start(now);

        sources.push(src, osc);
        gains.push(gain, oGain);
      };

      setupChannel(makeNoise(), -1, 200);
      setupChannel(makeNoise(), +1, 210);

      this.noiseNodes = { sources, gains };
    }

    stopBackgroundNoise() {
      if (!this.noiseNodes) return;
      const ctx = this.audioCtx;
      const now = ctx.currentTime;

      this.noiseNodes.gains.forEach(g => {
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.linearRampToValueAtTime(0, now + 0.8);
      });

      const sources = this.noiseNodes.sources;
      setTimeout(() => {
        sources.forEach(s => { try { s.stop(); } catch (e) {} });
      }, 900);

      this.noiseNodes = null;
    }

    // ————————————————————————————————————————————————
    // 5. 静寂モード（1分暗転 / タップで復帰 / 5秒無操作で再暗転）
    // ————————————————————————————————————————————————
    static get IDLE_RE_DIM_MS() { return 5000; }

    enterQuietMode() {
      if (!this.isRunning) return;
      this.clearIdleReDimCountdown();
      this.quietExited = false;

      this.els.positionGuide.classList.add('hidden');
      this.els.eyesMessage.classList.remove('fading');
      void this.els.eyesMessage.offsetWidth;
      this.els.eyesMessage.classList.add('visible');

      this.els.dimOverlay.classList.add('active');
      document.body.classList.add('dim-mode');

      this.schedule(() => {
        if (!this.isRunning || this.quietExited) return;
        this.els.eyesMessage.classList.remove('visible');
        this.els.eyesMessage.classList.add('fading');
      }, 7500);

      this.schedule(() => {
        if (this.quietExited) return;
        this.els.eyesMessage.classList.remove('fading');
      }, 14000);
    }

    onDimOverlayTap() {
      if (!this.isRunning) return;
      if (!this.els.dimOverlay.classList.contains('active')) return;

      this.quietExited = true;

      this.els.eyesMessage.classList.remove('visible', 'fading');
      this.els.positionGuide.classList.remove('hidden');

      document.body.classList.remove('dim-mode', 'dim-peek');
      this.els.dimOverlay.classList.remove('peek');

      this.els.dimOverlay.classList.add('dismissing');
      void this.els.dimOverlay.offsetWidth;
      this.els.dimOverlay.classList.remove('active');

      const fin = () => {
        this.els.dimOverlay.classList.remove('dismissing');
        this.els.dimOverlay.removeEventListener('transitionend', onOpacityEnd);
      };
      const onOpacityEnd = (e) => {
        if (e.propertyName === 'opacity') fin();
      };
      this.els.dimOverlay.addEventListener('transitionend', onOpacityEnd);
      setTimeout(fin, 500);
      this.scheduleIdleReDim();
    }

    resetQuietMode() {
      this.clearIdleReDimCountdown();
      this.quietExited = false;
      this.els.positionGuide.classList.remove('hidden');
      this.els.eyesMessage.classList.remove('visible', 'fading');
      this.els.dimOverlay.classList.remove('active', 'dismissing', 'peek');
      document.body.classList.remove('dim-mode', 'dim-peek');
    }

    clearIdleReDimCountdown() {
      this._idleReDimArmed = false;
      if (this._idleReDimTimer) {
        clearTimeout(this._idleReDimTimer);
        this._idleReDimTimer = null;
      }
      this._unbindIdleReDimListeners();
    }

    _bindIdleReDimListeners() {
      if (this._idleReDimBound) return;
      document.addEventListener('pointerdown', this._onIdleReDimUserAction, true);
      document.addEventListener('keydown', this._onIdleReDimUserAction, true);
      this._idleReDimBound = true;
    }

    _unbindIdleReDimListeners() {
      if (!this._idleReDimBound) return;
      document.removeEventListener('pointerdown', this._onIdleReDimUserAction, true);
      document.removeEventListener('keydown', this._onIdleReDimUserAction, true);
      this._idleReDimBound = false;
    }

    bumpIdleReDim() {
      if (!this._idleReDimArmed) return;
      if (this._idleReDimTimer) {
        clearTimeout(this._idleReDimTimer);
        this._idleReDimTimer = null;
      }
      this._idleReDimTimer = setTimeout(() => {
        this._idleReDimTimer = null;
        this._idleReDimArmed = false;
        this._unbindIdleReDimListeners();
        if (this.isRunning && !this.els.dimOverlay.classList.contains('active')) {
          this.enterQuietMode();
        }
      }, BreathingApp.IDLE_RE_DIM_MS);
    }

    scheduleIdleReDim() {
      this.clearIdleReDimCountdown();
      this._idleReDimArmed = true;
      this._bindIdleReDimListeners();
      this.bumpIdleReDim();
    }

    // ————————————————————————————————————————————————
    // 6. タイマー（setTimeout 登録。stop で一括 clear） + 1 分アクティブ到達
    // ————————————————————————————————————————————————
    _schedule1MinMilestones() {
      if (this._oneMinMilestoneDone) return;
      const active = performance.now() - this.startTime;
      const d = 60000 - active;
      const fire = () => {
        if (this._oneMinMilestoneDone || !this.isRunning) return;
        this._oneMinMilestoneDone = true;
        if (this.audioCtx) {
          const now = this.audioCtx.currentTime;
          this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
          this.masterGain.gain.linearRampToValueAtTime(0.36, now + 15);
        }
        this.enterQuietMode();
      };
      if (d <= 0) {
        this.schedule(fire, 0);
      } else {
        this.schedule(fire, d);
      }
    }

    schedule(fn, ms) {
      const id = setTimeout(fn, ms);
      this.timers.push(id);
      return id;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    new BreathingApp();
  });
})();
