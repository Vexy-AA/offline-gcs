/* ---------- start ---------- */
readColors();
{
  const saved = store.get(LS_LAYOUT);
  const src = saved && Array.isArray(saved.graphs) ? saved.graphs : DEMO_LAYOUT;
  st.graphs = src.map(mkGraph);
  st.active = st.graphs.length ? st.graphs[0].id : null;
  st.snap = serialize();
}
updateUndo(); applyDragMode(); buildHelp(); renderSide(); renderGraphs();
new ResizeObserver(() => requestDraw(true)).observe($('main'));
const retheme = () => { readColors(); if (V3.g) { V3.readColors(); V3.cfgKey.paths = null; V3.apply(); } requestDraw(true); };
const mq = window.matchMedia('(prefers-color-scheme: dark)');
if (mq.addEventListener) mq.addEventListener('change', retheme); else mq.addListener(retheme);
new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(retheme);
openFile(() => new File([DF.demoLog()], 'demo-copter.bin'), true);
