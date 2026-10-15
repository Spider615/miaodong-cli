import { isEdgeCell } from './canvas.mjs';
import { boxOf, edgeCurve } from './layout-geometry.mjs';

const escape = (v) =>
  String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const color = (n) =>
  n.data?.type === 'rule-center'
    ? '#db9b31'
    : /llm/.test(n.data?.type)
      ? '#397bbb'
      : /javascript|update-data/.test(n.data?.type)
        ? '#8773b6'
        : '#399583';
const minimal = (canvas) =>
  canvas.map((c) =>
    isEdgeCell(c)
      ? { id: c.id, source: c.source, target: c.target }
      : {
          id: c.id,
          name: c.data?.name ?? c.data?.text ?? c.id,
          type: c.data?.type,
          position: c.position,
          size: c.size,
        },
  );

function svgOf(canvas, eventLinks, prefix) {
  const nodes = canvas.filter((c) => !isEdgeCell(c)),
    edges = canvas.filter(isEdgeCell),
    map = new Map(nodes.map((n) => [n.id, n])),
    b = boxOf(nodes),
    view = [
      b.x - 100,
      b.y - 100,
      Math.max(600, b.width + 200),
      Math.max(300, b.height + 200),
    ];
  const paths = edges
    .map(
      (e) =>
        `<path d="${edgeCurve(map, e).d}" fill="none" stroke="#7890a8" stroke-width="2"/>`,
    )
    .join('');
  const events = eventLinks
    .map((l) => {
      const s = map.get(l.from),
        t = map.get(l.to);
      if (!s || !t) return '';
      const x = s.position.x + s.size.width,
        y = s.position.y + s.size.height / 2,
        tx = t.position.x,
        ty = t.position.y + t.size.height / 2,
        dx = Math.max(120, Math.abs(tx - x) * 0.45);
      return `<path data-event="${escape(l.eventId)}" data-from="${escape(l.from)}" data-to="${escape(l.to)}" d="M ${x} ${y} C ${x + dx} ${y} ${tx - dx} ${ty} ${tx} ${ty}" fill="none" stroke="#d67c2a" stroke-width="3" stroke-dasharray="12 8" marker-end="url(#${prefix}arrow)" style="display:none"><title>${escape(l.eventName ?? l.eventId)}</title></path>`;
    })
    .join('');
  const cards = nodes
    .map((n, i) => {
      const { x, y } = n.position,
        { width: w, height: h } = n.size,
        name = n.data?.name ?? n.data?.text ?? n.id,
        c = color(n);
      return `<g data-node="${escape(n.id)}" style="cursor:pointer"><title>${escape(name)} [${escape(n.id)}]</title><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="white" stroke="#bccbd9" stroke-width="1.5"/><rect x="${x}" y="${y}" width="5" height="${h}" fill="${c}"/><clipPath id="${prefix}clip${i}"><rect x="${x + 8}" y="${y + 2}" width="${Math.max(1, w - 16)}" height="${Math.max(1, h - 4)}"/></clipPath><g clip-path="url(#${prefix}clip${i})"><text x="${x + 14}" y="${y + 27}" fill="#243e56" font-size="18" font-weight="600">${escape(name)}</text>${h > 68 ? `<text x="${x + 14}" y="${y + 59}" fill="#7b8a9a" font-size="12">${escape(n.id.slice(0, 8))}</text>` : ''}</g></g>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.join(' ')}" width="${view[2]}" height="${view[3]}" style="background:#fafcfe;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif" role="img" aria-label="画布布局"><defs><marker id="${prefix}arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#d67c2a"/></marker></defs>${paths}${events}${cards}</svg>`;
}

function client() {
  const data = JSON.parse(document.getElementById('data').textContent),
    $ = (id) => document.getElementById(id),
    svgs = [...document.querySelectorAll('.view svg')];
  let selected = null,
    active = 1,
    view = [];
  const models = [data.before, data.after].map((c) => ({
    nodes: c.filter((n) => !n.source),
    edges: c.filter((n) => n.source),
    map: new Map(c.filter((n) => !n.source).map((n) => [n.id, n])),
  }));
  const bounds = (ns) => {
    if (!ns.length) return [0, 0, 600, 300];
    const x = Math.min(...ns.map((n) => n.position.x)),
      y = Math.min(...ns.map((n) => n.position.y));
    return [
      x - 100,
      y - 100,
      Math.max(
        300,
        Math.max(...ns.map((n) => n.position.x + n.size.width)) - x + 200,
      ),
      Math.max(
        250,
        Math.max(...ns.map((n) => n.position.y + n.size.height)) - y + 200,
      ),
    ];
  };
  function render() {
    svgs.forEach((svg, i) => {
      svg.parentElement.hidden = i !== active;
      for (const path of svg.querySelectorAll('[data-event]'))
        path.style.display =
          $('events').checked &&
          selected &&
          selected.has(path.dataset.from) &&
          selected.has(path.dataset.to)
            ? ''
            : 'none';
      for (const n of svg.querySelectorAll('[data-node]'))
        n.style.opacity =
          !selected || selected.has(n.dataset.node) ? '1' : '.18';
    });
    svgs[active].setAttribute('viewBox', view.join(' '));
  }
  function fit() {
    const ns = models[active].nodes.filter(
      (n) => !selected || selected.has(n.id),
    );
    view = bounds(ns);
    render();
  }
  $('before').onclick = () => {
    active = 0;
    fit();
  };
  $('after').onclick = () => {
    active = 1;
    fit();
  };
  $('fit').onclick = fit;
  $('all').onclick = () => {
    selected = null;
    $('status').textContent = '全图；点击节点可查看其上下游和事件入口';
    fit();
  };
  $('events').onchange = render;
  function focus(ids) {
    selected = new Set(ids);
    fit();
  }
  function around(id) {
    const ids = new Set([id]);
    for (const e of models[active].edges)
      if (e.source.cell === id || e.target.cell === id) {
        ids.add(e.source.cell);
        ids.add(e.target.cell);
      }
    for (const l of data.events)
      if (l.from === id || l.to === id) {
        ids.add(l.from);
        ids.add(l.to);
        for (const e of models[active].edges)
          if (e.source.cell === l.to) ids.add(e.target.cell);
      }
    return [...ids];
  }
  $('find').onclick = () => {
    const q = $('search').value.trim();
    if (!q) return;
    const hits = models[active].nodes.filter(
      (n) => n.id.startsWith(q) || n.name.includes(q),
    );
    if (!hits.length) {
      $('status').textContent = '未找到节点';
      return;
    }
    focus(hits.flatMap((n) => around(n.id)));
    $('status').textContent =
      '匹配 ' + hits.length + ' 个节点；橙色虚线表示已有事件关联';
  };
  $('search').onkeydown = (e) => {
    if (e.key === 'Enter') $('find').click();
  };
  for (const [i, l] of data.events.entries()) {
    const option = document.createElement('option');
    option.value = i;
    option.textContent =
      (l.eventName ?? l.eventId) +
      ' [' +
      l.from.slice(0, 8) +
      ' → ' +
      l.to.slice(0, 8) +
      ']';
    $('event').append(option);
  }
  $('event').onchange = () => {
    if ($('event').value === '') return;
    const l = data.events[Number($('event').value)];
    focus([...around(l.from), ...around(l.to)]);
    $('events').checked = true;
    render();
    $('status').textContent = '按同一事件 ID 接续；虚线不会写入实际画布';
  };
  for (const svg of svgs) {
    let drag = null;
    const selectNode = (id) => {
      if (id) {
        focus(around(id));
        $('status').textContent =
          models[active].map.get(id).name + ' [' + id + ']';
      }
    };
    svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const k = Math.exp(e.deltaY * 0.001),
          p = new DOMPoint(e.clientX, e.clientY).matrixTransform(
            svg.getScreenCTM().inverse(),
          ),
          cx = p.x,
          cy = p.y;
        view = [
          cx + (view[0] - cx) * k,
          cy + (view[1] - cy) * k,
          view[2] * k,
          view[3] * k,
        ];
        render();
      },
      { passive: false },
    );
    svg.addEventListener('pointerdown', (e) => {
      drag = {
        x: e.clientX,
        y: e.clientY,
        startX: e.clientX,
        startY: e.clientY,
        id: e.target.closest('[data-node]')?.dataset.node,
        moved: false,
      };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const ctm = svg.getScreenCTM();
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 3)
        drag.moved = true;
      view[0] -= (e.clientX - drag.x) / ctm.a;
      view[1] -= (e.clientY - drag.y) / ctm.d;
      drag.x = e.clientX;
      drag.y = e.clientY;
      render();
    });
    svg.addEventListener('pointerup', () => {
      const id = drag && !drag.moved ? drag.id : null;
      drag = null;
      selectNode(id);
    });
    svg.addEventListener('pointercancel', () => {
      drag = null;
    });
  }
  $('zoomIn').onclick = () => {
    view[0] += view[2] * 0.1;
    view[1] += view[3] * 0.1;
    view[2] *= 0.8;
    view[3] *= 0.8;
    render();
  };
  $('zoomOut').onclick = () => {
    view[0] -= view[2] * 0.125;
    view[1] -= view[3] * 0.125;
    view[2] *= 1.25;
    view[3] *= 1.25;
    render();
  };
  fit();
}

export function renderLayoutPreview(before, after, report, title = '画布布局') {
  const eventLinks = report.eventLinks ?? [],
    beforeSvg = svgOf(before.canvas, eventLinks, 'b'),
    svg = svgOf(after.canvas, eventLinks, 'a');
  const data = {
    before: minimal(before.canvas),
    after: minimal(after.canvas),
    events: eventLinks,
  };
  const b = report.before,
    a = report.after,
    metric = (key) =>
      (b[key] ?? 0).toLocaleString() + ' → ' + (a[key] ?? 0).toLocaleString();
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>*{box-sizing:border-box}body{margin:0;color:#1d354b;background:#f4f7fa;font:14px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}header,nav,footer{padding:16px 24px;background:white;border-bottom:1px solid #d9e3ed}h1{font-size:23px;margin:0 0 6px}.muted{color:#62788e}nav{display:flex;gap:9px;flex-wrap:wrap;align-items:center}button,input,select{font:inherit;padding:8px 12px;border:1px solid #c8d5e2;border-radius:5px;background:white;color:#203c55}button{cursor:pointer}input{width:200px}select{max-width:440px}input[type=checkbox]{width:auto}.view{margin:14px;border:1px solid #dbe4ee;background:#fafcfe;border-radius:8px;overflow:hidden}.view[hidden]{display:none}.view svg{display:block;width:100%;height:calc(100vh - 280px);min-height:420px;touch-action:none;cursor:grab}footer{font-size:12px}a{color:#2666a8}</style><header><h1>${escape(title)} <small class="muted">本地预览 · 尚未写入秒懂</small></h1><div>节点重叠 ${metric('overlapPairs')} · 实线穿过节点（近似）${metric('edgeNodeIntersections')} · 画布面积 ${metric('area')}</div><div class="muted">跨链路事件平均距离 ${(report.eventDistances?.before?.mean ?? 0).toLocaleString()} → ${(report.eventDistances?.after?.mean ?? 0).toLocaleString()}；只改变位置及旧拐点，业务配置保持。容器内相对布局保留。</div></header><nav><button id="before">整理前</button><button id="after">整理后</button><button id="all">全图</button><button id="fit">适合窗口</button><button id="zoomIn">＋</button><button id="zoomOut">－</button><input id="search" placeholder="节点名或 ID 前缀" aria-label="搜索节点"><button id="find">查找</button><select id="event" aria-label="定位事件接续"><option value="">定位事件接续</option></select><label><input id="events" type="checkbox" checked>事件虚线</label></nav><main><div class="view" hidden>${beforeSvg}</div><div class="view">${svg}</div></main><footer><span id="status">滚轮缩放，拖动画布；点击节点查看上下游。</span> · 虚线仅展示已有事件关联；卡片为示意样式，其他 connector/router 的连线需在编辑器复核。 <a href="optimized.svg">SVG 图片</a> · <a href="report.json">检查报告</a></footer><script id="data" type="application/json">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script><script>(${client.toString()})();</script></html>`;
  return { beforeSvg, svg, html };
}
