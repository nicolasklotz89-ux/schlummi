// Früh geladen, damit beim Start nicht kurz das falsche Design aufblitzt.
(function () {
  var t = 'auto', dim = true;
  try { t = JSON.parse(localStorage.getItem('schlummi.theme')) || 'auto'; } catch (e) {}
  try { var d = localStorage.getItem('schlummi.dim'); if (d !== null) dim = JSON.parse(d); } catch (e) {}
  var dark = t === 'dark' || (t === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  var h = new Date().getHours();
  var eff = dark ? ((dim && (h >= 20 || h < 7)) ? 'dim' : 'dark') : 'light';
  document.documentElement.dataset.theme = eff;
})();
