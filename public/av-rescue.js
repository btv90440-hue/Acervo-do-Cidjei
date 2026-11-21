/*
 * Reprodução automática de áudio.
 * Quando o áudio do arquivo não é tocado pelo navegador (AC-3, E-AC-3, DTS, TrueHD...),
 * o servidor gera uma cópia com o vídeo intacto e o áudio em AAC. O player troca para ela
 * na mesma posição. Não há nada para o usuário fazer.
 */
(() => {
  const POLL_MS = 1500;
  const MESSAGES = {
    probing: 'Analisando o áudio…',
    queued: 'Aguardando vez para converter o áudio…',
    running: 'Convertendo o áudio para reprodução…',
  };
  const runs = new WeakMap(); // <video> -> número da verificação mais recente
  let toast = null;

  // Extrai ID e token público de uma URL /api/stream/ID?public=TOKEN.
  function sourceOf(video) {
    let url;
    try {
      url = new URL(video.currentSrc || video.getAttribute('src') || '', location.href);
    } catch {
      return null;
    }
    const m = url.pathname.match(/^\/api\/stream\/([^/]+)$/);
    const token = url.searchParams.get('public');
    return m && token ? { id: m[1], token } : null;
  }

  async function ask(method, src) {
    const path = `/api/transcode/${encodeURIComponent(src.id)}?public=${encodeURIComponent(src.token)}`;
    try {
      const res = await fetch(path, { method, cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (data && typeof data.state === 'string') return data;
      return { state: 'failed', error: `HTTP ${res.status}` };
    } catch {
      return { state: 'failed', error: 'sem conexão com o servidor' };
    }
  }

  async function check(video) {
    const src = sourceOf(video);
    if (!src) return; // versão já convertida, ou arquivo fora do acervo público
    const run = (runs.get(video) || 0) + 1;
    runs.set(video, run);
    const current = () => runs.get(video) === run && video.isConnected && sourceOf(video)?.id === src.id;

    let info = await ask('POST', src);
    let wasPlaying = null; // só é preenchido se precisarmos pausar

    while (current()) {
      if (info.state === 'ready') return switchTo(video, src, wasPlaying ?? !video.paused);
      if (info.state === 'not_needed' || info.state === 'none' || info.state === 'unavailable') {
        return hide();
      }
      if (info.state === 'failed') {
        if (wasPlaying) video.play().catch(() => {});
        return showError(info.error);
      }
      // probing | queued | running: pausa enquanto converte
      if (wasPlaying === null) {
        wasPlaying = !video.paused;
        video.pause();
      }
      show(MESSAGES[info.state] || 'Preparando o áudio…', info.state === 'running' ? info.progress : null);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      info = await ask('GET', src);
    }
    hide();
  }

  // Troca para a versão convertida e volta à posição (e ao estado de reprodução) anteriores.
  function switchTo(video, src, playing) {
    const at = video.currentTime;
    hide();
    video.addEventListener('loadedmetadata', () => {
      try { video.currentTime = at; } catch { /* alguns navegadores exigem carregamento completo */ }
      if (playing) video.play().catch(() => {});
    }, { once: true });
    video.src = `/api/transcoded/${encodeURIComponent(src.id)}?public=${encodeURIComponent(src.token)}`;
  }

  function show(message, progress) {
    if (!toast) {
      toast = document.createElement('div');
      toast.setAttribute('role', 'status');
      toast.style.cssText = [
        'position:fixed', 'top:16px', 'left:50%', 'transform:translateX(-50%)', 'z-index:2147483647',
        'min-width:280px', 'max-width:90vw', 'padding:12px 16px', 'border-radius:10px',
        'background:#18181c', 'color:#f2f2f2', 'border:1px solid #3a3a44',
        'box-shadow:0 10px 30px rgba(0,0,0,.45)', 'font:14px/1.4 system-ui,sans-serif', 'text-align:center',
      ].join(';');
      document.body.appendChild(toast);
    }
    const pct = typeof progress === 'number' && progress > 0 ? Math.round(progress * 100) : null;
    toast.textContent = pct === null ? message : `${message} ${pct}%`;
    if (pct !== null) {
      const bar = document.createElement('div');
      bar.style.cssText = 'margin-top:8px;height:6px;border-radius:3px;background:#2c2c34;overflow:hidden';
      const fill = document.createElement('div');
      fill.style.cssText = `height:100%;width:${pct}%;background:#6b8cff;transition:width .4s`;
      bar.appendChild(fill);
      toast.appendChild(bar);
    }
  }

  function showError(detail) {
    show('Não foi possível preparar o áudio deste arquivo.');
    if (detail) console.warn('av-rescue:', detail);
    const id = toast;
    setTimeout(() => { if (toast === id) hide(); }, 9000);
  }

  function hide() {
    if (toast) {
      toast.remove();
      toast = null;
    }
  }

  // Captura o evento de todos os <video> da página, inclusive os criados depois.
  document.addEventListener('loadedmetadata', (event) => {
    if (event.target instanceof HTMLVideoElement) check(event.target);
  }, true);
})();
