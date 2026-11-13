(function(){
// Ambiance sonore 100 % générée par le navigateur (aucun fichier audio) : vent, crépitement du feu, oiseaux + bruitages.
const KEY = 'cb_sound';
let ctx = null, master = null, sfxG = null, on = false, started = false, timers = [];

function noise(sec) { const b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; return b; }
function ensure() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
    sfxG = ctx.createGain(); sfxG.gain.value = .5; sfxG.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
}
function build() {
  if (started) return; started = true;
  const w = ctx.createBufferSource(); w.buffer = noise(4); w.loop = true;                       // vent
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 480;
  const g = ctx.createGain(); g.gain.value = .13;
  const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = .11; lg.gain.value = .07; lfo.connect(lg); lg.connect(g.gain); lfo.start();
  w.connect(lp); lp.connect(g); g.connect(master); w.start();
  const crackle = () => {                                                                         // feu de camp
    if (on) {
      const s = ctx.createBufferSource(); s.buffer = noise(.08);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1200 + Math.random() * 2500;
      const e = ctx.createGain(), t = ctx.currentTime; e.gain.setValueAtTime(.06 + Math.random() * .16, t); e.gain.exponentialRampToValueAtTime(.001, t + .02 + Math.random() * .05);
      s.connect(hp); hp.connect(e); e.connect(master); s.start(t);
    }
    timers.push(setTimeout(crackle, 70 + Math.random() * 380));
  };
  const bird = () => {                                                                            // oiseaux
    if (on) {
      const n = 2 + (Math.random() * 3 | 0), base = 2200 + Math.random() * 1800;
      for (let i = 0; i < n; i++) {
        const o = ctx.createOscillator(), e = ctx.createGain(), t = ctx.currentTime + i * .13;
        o.type = 'sine'; o.frequency.setValueAtTime(base, t); o.frequency.exponentialRampToValueAtTime(base * (1.2 + Math.random() * .5), t + .09);
        e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(.05, t + .02); e.gain.exponentialRampToValueAtTime(.001, t + .11);
        o.connect(e); e.connect(master); o.start(t); o.stop(t + .13);
      }
    }
    timers.push(setTimeout(bird, 2500 + Math.random() * 5500));
  };
  crackle(); bird();
}
function tone(f1, f2, dur, vol, type) {
  if (!on || !ctx) return;
  const o = ctx.createOscillator(), e = ctx.createGain(), t = ctx.currentTime;
  o.type = type || 'triangle'; o.frequency.setValueAtTime(f1, t); o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  e.gain.setValueAtTime(vol, t); e.gain.exponentialRampToValueAtTime(.001, t + dur);
  o.connect(e); e.connect(sfxG); o.start(t); o.stop(t + dur + .02);
}
const sfx = {
  click: () => tone(520, 880, .12, .22),
  hover: () => tone(1100, 1300, .04, .05, 'sine'),
  success: () => { tone(523, 523, .12, .2); setTimeout(() => tone(659, 659, .12, .2), 110); setTimeout(() => tone(784, 784, .25, .2), 220); },
  error: () => tone(300, 150, .25, .2, 'sawtooth')
};
function isOn() { return on; }
function paint() { const b = document.getElementById('snd'); if (b) { b.textContent = on ? '🔊' : '🔇'; b.title = on ? "Couper l'ambiance sonore" : "Activer l'ambiance sonore"; b.classList.remove('hint'); } }
function setSound(v) {
  on = v; try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) {}
  if (v) { ensure(); build(); master.gain.cancelScheduledValues(ctx.currentTime); master.gain.linearRampToValueAtTime(.55, ctx.currentTime + 1.2); setTimeout(() => sfx.click(), 30); }
  else if (master) { master.gain.linearRampToValueAtTime(0, ctx.currentTime + .5); }
  paint();
}
function initSound() {
  const b = document.getElementById('snd'); if (!b) return;
  let pref = null; try { pref = localStorage.getItem(KEY); } catch (e) {}
  paint(); if (pref === null) b.classList.add('hint');
  b.addEventListener('click', () => setSound(!on));
  if (pref === '1') {                                  // le navigateur exige un clic avant de jouer du son
    const go = () => { setSound(true); removeEventListener('pointerdown', go); removeEventListener('keydown', go); };
    addEventListener('pointerdown', go, { once: true }); addEventListener('keydown', go, { once: true });
  }
  document.addEventListener('click', e => { if (e.target.closest('.btn,nav a')) sfx.click(); });
  document.addEventListener('pointerover', e => { const t = e.target.closest('.btn,nav a,.card,.shot'); if (t && !t.contains(e.relatedTarget)) sfx.hover(); });
}

window.CBSound={setSound:setSound,isOn:isOn};window.sfx=sfx;
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initSound);else initSound();
})();
