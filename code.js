figma.showUI(__html__, {
  width: 360,
  height: 520,
  themeColors: true
});

const MIN_SCORE = 35;
const ROOT_TYPES = new Set(["FRAME", "COMPONENT", "INSTANCE", "GROUP"]);
const MAX_CANDIDATES = 500;
const MAX_WALK_NODES = 250;
const CHUNK_SIZE = 20;

function log(message) {
  figma.ui.postMessage({ type: "scan-log", message });
}

function wait() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function canHaveChildren(node) {
  return "children" in node;
}

function getTextCharacters(node) {
  if (node.type === "TEXT") {
    return node.characters || "";
  }

  if (!canHaveChildren(node)) {
    return "";
  }

  return node.children
    .map(getTextCharacters)
    .filter(Boolean)
    .join(" ");
}

function words(value) {
  return new Set(
    String(value || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2)
  );
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  const intersection = [...a].filter((item) => b.has(item)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function getPaintColor(paint) {
  if (!paint || paint.type !== "SOLID" || !paint.color) return null;
  const r = Math.round(paint.color.r * 255);
  const g = Math.round(paint.color.g * 255);
  const b = Math.round(paint.color.b * 255);
  return `${r},${g},${b}`;
}

function addPaints(node, colors) {
  if ("fills" in node && Array.isArray(node.fills)) {
    for (const fill of node.fills) {
      const color = getPaintColor(fill);
      if (color) colors.push(color);
    }
  }

  if ("strokes" in node && Array.isArray(node.strokes)) {
    for (const stroke of node.strokes) {
      const color = getPaintColor(stroke);
      if (color) colors.push(color);
    }
  }
}

function collectNodeInfo(node) {
  const typeCounts = {};
  const componentKeys = [];
  const names = [];
  const colors = [];
  const typeSequence = [];
  const textParts = [];
  let childCount = 0;

  function walk(current) {
    if (childCount >= MAX_WALK_NODES) return;

    typeCounts[current.type] = (typeCounts[current.type] || 0) + 1;
    typeSequence.push(current.type);
    names.push((current.name || "").toLowerCase());
    addPaints(current, colors);

    if (current.type === "TEXT" && current.characters) {
      textParts.push(current.characters);
    }

    if (current.type === "COMPONENT") {
      componentKeys.push(current.key);
    }

    if (current.id !== node.id) {
      childCount += 1;
    }

    if (current.type === "INSTANCE" && current.mainComponent) {
      try {
        componentKeys.push(current.mainComponent.key);
      } catch (error) {
        // Some library components can be unavailable locally.
      }
    }

    if (canHaveChildren(current)) {
      for (const child of current.children) {
        if (childCount < MAX_WALK_NODES) walk(child);
      }
    }
  }

  walk(node);

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    text: textParts.join(" ").toLowerCase(),
    width: Math.round(node.width || 0),
    height: Math.round(node.height || 0),
    typeCounts,
    componentKeys,
    names,
    colors,
    typeSequence,
    childCount
  };
}

function scoreCandidate(target, candidate) {
  let score = 0;
  const reasons = [];

  if (target.id === candidate.id) {
    return { score: 0, reasons: [] };
  }

  const sharedComponents = [...new Set(target.componentKeys)].filter((key) =>
    new Set(candidate.componentKeys).has(key)
  );

  if (sharedComponents.length > 0) {
    score += Math.min(45, 28 + sharedComponents.length * 8);
    reasons.push("Same component");
  }

  const textScore = jaccard(words(target.text), words(candidate.text));
  if (textScore > 0) {
    score += Math.round(textScore * 22);
    reasons.push("Similar text");
  }

  const nameScore = jaccard(new Set(target.names.flatMap((name) => [...words(name)])), new Set(candidate.names.flatMap((name) => [...words(name)])));
  if (nameScore > 0) {
    score += Math.round(nameScore * 12);
    reasons.push("Similar layer names");
  }

  const typeKeys = new Set([...Object.keys(target.typeCounts), ...Object.keys(candidate.typeCounts)]);
  let typeSimilarity = 0;
  for (const type of typeKeys) {
    const max = Math.max(target.typeCounts[type] || 0, candidate.typeCounts[type] || 0);
    const min = Math.min(target.typeCounts[type] || 0, candidate.typeCounts[type] || 0);
    typeSimilarity += max ? min / max : 0;
  }
  typeSimilarity = typeKeys.size ? typeSimilarity / typeKeys.size : 0;
  if (typeSimilarity > 0.35) {
    score += Math.round(typeSimilarity * 22);
    reasons.push("Layer structure");
  }

  const sequenceA = target.typeSequence.join("/");
  const sequenceB = candidate.typeSequence.join("/");
  if (sequenceA === sequenceB && sequenceA.length > 0) {
    score += 18;
    reasons.push("Same structure order");
  }

  const colorScore = jaccard(new Set(target.colors), new Set(candidate.colors));
  if (colorScore > 0) {
    score += Math.round(colorScore * 18);
    reasons.push("Similar colors");
  }

  const targetRatio =
    target.width && target.height ? target.width / target.height : 0;

  const candidateRatio =
    candidate.width && candidate.height
      ? candidate.width / candidate.height
      : 0;

  if (
    targetRatio &&
    candidateRatio &&
    Math.abs(targetRatio - candidateRatio) < 0.15
  ) {
    score += 8;
    reasons.push("Similar proportions");
  }

  if (Math.abs(target.width - candidate.width) <= 2 && Math.abs(target.height - candidate.height) <= 2) {
    score += 12;
    reasons.push("Same size");
  }

  return {
    score: Math.min(score, 100),
    reasons
  };
}

async function getSelectedLayer() {
  const selected = figma.currentPage.selection[0];

  if (!selected) {
    figma.ui.postMessage({
      type: "no-selection"
    });
    return;
  }

  const info = collectNodeInfo(selected);

  figma.ui.postMessage({
    type: "selection-found",
    layer: {
      id: selected.id,
      name: selected.name,
      type: selected.type,
      width: info.width,
      height: info.height,
      pageName: figma.currentPage.name,
      layers: info.childCount
    }
  });
}

function getSearchRoots(targetType) {
  const roots = [];

  function add(page, node) {
    if (roots.length >= MAX_CANDIDATES || node.removed) return;
    roots.push({ page, node });
  }

  function walk(page, node, depth) {
    if (roots.length >= MAX_CANDIDATES) return;

    const isTopLevelCandidate = depth === 0 && ROOT_TYPES.has(node.type);
    const isSameTypeNestedCandidate = depth > 0 && node.type === targetType;

    if (isTopLevelCandidate || isSameTypeNestedCandidate) {
      add(page, node);
    }

    if (canHaveChildren(node)) {
      for (const child of node.children) walk(page, child, depth + 1);
    }
  }

  for (const page of figma.root.children) {
    for (const child of page.children) walk(page, child, 0);
  }

  return roots;
}

async function scanCurrentFile() {
  const selected = figma.currentPage.selection[0];

  if (!selected) {
    figma.ui.postMessage({
      type: "no-selection"
    });
    return;
  }

  figma.ui.postMessage({
    type: "scan-started"
  });

  log("Loading all pages...");
  await figma.loadAllPagesAsync();

  log("Reading selected layer...");
  const target = collectNodeInfo(selected);
  const roots = getSearchRoots(selected.type);
  const matches = [];

  log(`Checking ${roots.length} candidate layers...`);

  for (let index = 0; index < roots.length; index += 1) {
    const item = roots[index];
    const candidate = collectNodeInfo(item.node);
    const result = scoreCandidate(target, candidate);

    if (result.score >= MIN_SCORE) {
      matches.push({
        id: item.node.id,
        pageId: item.page.id,
        name: item.node.name,
        page: item.page.name,
        type: item.node.type,
        width: candidate.width,
        height: candidate.height,
        layers: candidate.childCount,
        score: result.score,
        reasons: result.reasons.slice(0, 2)
      });
    }

    if (index > 0 && index % CHUNK_SIZE === 0) {
      log(`Scanned ${index}/${roots.length} candidates...`);
      await wait();
    }
  }

  matches.sort((a, b) => b.score - a.score);
  log(`Done. Found ${matches.length} matches.`);

  figma.ui.postMessage({
    type: "scan-results",
    matches: matches.slice(0, 50)
  });
}

async function takeMeThere(match) {
  const page = figma.root.findOne((node) => node.id === match.pageId);
  const node = figma.root.findOne((item) => item.id === match.id);

  if (!page || !node) {
    figma.notify("Could not find that match anymore.");
    return;
  }

  await figma.setCurrentPageAsync(page);
  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);

  figma.ui.postMessage({
    type: "taken-there",
    match
  });
}

async function flagMatch(match) {
  const node = figma.root.findOne((item) => item.id === match.id);

  if (!node || !node.parent) {
    figma.notify("Could not flag that match.");
    return;
  }

  await figma.loadFontAsync({ family: "Inter", style: "Medium" });

  const label = figma.createText();
  label.name = "DesignTrace - Review needed";
  label.characters = "Review needed";
  label.fontName = { family: "Inter", style: "Medium" };
  label.fontSize = 12;
  label.fills = [
    {
      type: "SOLID",
      color: { r: 0.72, g: 0.2, b: 0.12 }
    }
  ];
  label.x = node.x;
  label.y = node.y - 24;

  node.parent.appendChild(label);

  figma.ui.postMessage({
    type: "flagged",
    match
  });
}

figma.ui.onmessage = async (message) => {
  if (message.type === "check-selection") {
    await getSelectedLayer();
  }

  if (message.type === "scan-file") {
    await scanCurrentFile();
  }

  if (message.type === "take-me-there") {
    await takeMeThere(message.match);
  }

  if (message.type === "flag-match") {
    await flagMatch(message.match);
  }

  if (message.type === "close") {
    figma.closePlugin();
  }
};
