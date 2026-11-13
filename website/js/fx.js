(function(){
// Animations : apparition au scroll, lucioles, parallaxe, inclinaison des cartes.
function initFx() {
  document.documentElement.classList.add('js');                       // le contenu n'est masqué (avant animation) que si ce script tourne
  setTimeout(() => document.querySelectorAll('.rv').forEach(e => e.classList.add('in')), 4000);   // filet de sécurité
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .12 });
  document.querySelectorAll('.rv').forEach(el => io.observe(el));
  if (reduced) return;

  const cv = document.createElement('canvas'); cv.id = 'ff'; document.body.appendChild(cv);
  const c = cv.getContext('2d'); let W = 0, H = 0;
  const size = () => { W = cv.width = innerWidth; H = cv.height = innerHeight; };
  size(); addEventListener('resize', size);
  const N = innerWidth < 700 ? 18 : 40, P = [];
  for (let i = 0; i < N; i++) P.push({ x: Math.random() * W, y: Math.random() * H, r: 1.5 + Math.random() * 2.5, vx: (Math.random() - .5) * .25, vy: -.1 - Math.random() * .3, ph: Math.random() * 6.28 });
  (function loop(t) {
    c.clearRect(0, 0, W, H);
    for (const p of P) {
      p.x += p.vx + Math.sin(t / 1500 + p.ph) * .3; p.y += p.vy;
      if (p.y < -10) { p.y = H + 10; p.x = Math.random() * W; } if (p.x < -10) p.x = W + 10; if (p.x > W + 10) p.x = -10;
      const a = .35 + .55 * Math.abs(Math.sin(t / 900 + p.ph)), g = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 6);
      g.addColorStop(0, 'rgba(255,230,120,' + a + ')'); g.addColorStop(1, 'rgba(255,200,60,0)');
      c.fillStyle = g; c.beginPath(); c.arc(p.x, p.y, p.r * 6, 0, 6.3); c.fill();
    }
    requestAnimationFrame(loop);
  })(0);

  const hero = document.querySelector('.hero img');
  if (hero) addEventListener('scroll', () => { const y = scrollY; if (y < innerHeight) hero.style.translate = '0 ' + (y * .22) + 'px'; }, { passive: true });

  document.querySelectorAll('.card').forEach(el => {
    el.addEventListener('pointermove', e => { const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5; el.style.transform = 'perspective(700px) rotateX(' + (-y * 7) + 'deg) rotateY(' + (x * 9) + 'deg) translateY(-4px)'; });
    el.addEventListener('pointerleave', () => { el.style.transform = ''; });
  });
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initFx);else initFx();
})();
