figma.showUI(__html__, {
  width: 360,
  height: 520,
  themeColors: true
});

const CONTAINER_TYPES = new Set(["FRAME", "COMPONENT", "INSTANCE", "GROUP", "SECTION", "COMPONENT_SET"]);
const VECTOR_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "ELLIPSE", "RECTANGLE", "LINE"]);
const GENERIC_NAME_PATTERN = /^(frame|group|rectangle|ellipse|line|polygon|star|vector|component|instance|section|boolean group)\s*\d*$/i;
const ICON_MAX_DIMENSION = 64;
const ICON_MIN_VECTOR_RATIO = 0.8;
const MAX_CANDIDATES = 700;
const MAX_CANDIDATE_POOL = 4000;
const MAX_WALK_NODES = 250;
const CHUNK_SIZE = 12;
const WALK_YIELD_INTERVAL = 400;

function wait() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function canHaveChildren(node) {
  return "children" in node;
}

function isGenericName(name) {
  return GENERIC_NAME_PATTERN.test(String(name || "").trim());
}

function getVectorCount(typeCounts) {
  let count = 0;
  for (const type of VECTOR_TYPES) {
    count += typeCounts[type] || 0;
  }
  return count;
}

function computeIsIcon(typeCounts, width, height, hasText, hasNestedComponentChild) {
  if (hasText || hasNestedComponentChild) return false;
  if (width > ICON_MAX_DIMENSION || height > ICON_MAX_DIMENSION) return false;

  const total = Object.values(typeCounts).reduce((sum, value) => sum + value, 0);
  if (!total) return false;

  return getVectorCount(typeCounts) / total >= ICON_MIN_VECTOR_RATIO;
}

function getNodeFamily(type) {
  if (CONTAINER_TYPES.has(type)) return "container";
  if (type === "TEXT") return "text";
  if (["RECTANGLE", "ELLIPSE", "LINE", "POLYGON", "STAR", "VECTOR", "BOOLEAN_OPERATION"].includes(type)) {
    return "shape";
  }
  return "other";
}

function closeness(a, b) {
  if (!a || !b) return 0;
  const distance = Math.abs(a - b) / Math.max(a, b);
  return Math.max(0, 1 - distance);
}

function getMinScore(target) {
  if (target.isIcon) return 70;

  if (target.family === "container") {
    if (target.childCount >= 10) return 64;
    if (target.childCount >= 4) return 58;
    return 52;
  }

  if (target.family === "text") return 48;
  return 44;
}

function typeCountSimilarity(targetTypeCounts, candidateTypeCounts) {
  const typeKeys = new Set([
    ...Object.keys(targetTypeCounts),
    ...Object.keys(candidateTypeCounts)
  ]);

  let similarity = 0;
  for (const type of typeKeys) {
    const max = Math.max(targetTypeCounts[type] || 0, candidateTypeCounts[type] || 0);
    const min = Math.min(targetTypeCounts[type] || 0, candidateTypeCounts[type] || 0);
    similarity += max ? min / max : 0;
  }

  return typeKeys.size ? similarity / typeKeys.size : 0;
}

function sequenceSimilarity(a, b) {
  const sampleSize = Math.min(a.length, b.length, 60);
  if (!sampleSize) return 0;
  let matches = 0;

  for (let index = 0; index < sampleSize; index += 1) {
    if (a[index] === b[index]) matches += 1;
  }

  return matches / sampleSize;
}

function shouldConsiderAsCandidate(target, node) {
  if (node.removed || node.id === target.id) return false;
  if (node.visible === false) return false;

  if (target.family === "container") {
    return CONTAINER_TYPES.has(node.type);
  }

  if (target.family === "text") {
    return node.type === "TEXT";
  }

  return node.type === target.type;
}

function getRoughCandidateScore(target, node) {
  let score = 0;
  const candidateFamily = getNodeFamily(node.type);
  const candidateDirectChildren = canHaveChildren(node) ? node.children.length : 0;
  const candidateWidth = Math.round(node.width || 0);
  const candidateHeight = Math.round(node.height || 0);

  if (node.type === target.type) {
    score += 35;
  } else if (candidateFamily === target.family) {
    score += 18;
  }

  score += Math.round(closeness(target.width, candidateWidth) * 20);
  score += Math.round(closeness(target.height, candidateHeight) * 20);

  if (target.family === "container") {
    score += Math.round(closeness(target.directChildCount, candidateDirectChildren) * 25);
  }

  return score;
}

function isCoarselyCompatible(target, candidate) {
  if (target.id === candidate.id) return false;
  if (target.family !== candidate.family) return false;

  if (target.family === "container") {
    if (target.childCount > 0 && candidate.childCount === 0) return false;

    const childSimilarity = closeness(target.childCount, candidate.childCount);
    const directChildSimilarity = closeness(target.directChildCount, candidate.directChildCount);

    if (target.childCount >= 4 && childSimilarity < 0.18) return false;
    if (target.directChildCount >= 2 && directChildSimilarity < 0.2) return false;
  }

  if (target.family === "text") {
    const targetTextWords = words(target.text);
    const candidateTextWords = words(candidate.text);
    if (targetTextWords.size > 0 && candidateTextWords.size === 0) return false;
  }

  if (target.isIcon && candidate.isIcon) {
    const candidateComponents = new Set(candidate.componentKeys);
    const candidateComponentSets = new Set(candidate.componentSetKeys);

    const hasComponentOverlap =
      target.componentKeys.some((key) => candidateComponents.has(key)) ||
      target.componentSetKeys.some((key) => candidateComponentSets.has(key));

    const nameOverlap = jaccard(words(target.name), words(candidate.name)) > 0.3;
    const vectorCountSimilarity = closeness(
      getVectorCount(target.typeCounts),
      getVectorCount(candidate.typeCounts)
    );

    if (!hasComponentOverlap && !nameOverlap && vectorCountSimilarity < 0.9) {
      return false;
    }
  }

  return true;
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
  const componentSetKeys = [];
  const names = [];
  const colors = [];
  const typeSequence = [];
  const textParts = [];
  let childCount = 0;
  let hasText = false;
  let hasNestedComponentChild = false;

  // Breadth-first so the MAX_WALK_NODES cap samples broadly across the tree
  // instead of exhausting the budget deep down the first branch.
  const queue = [node];

  while (queue.length > 0 && childCount < MAX_WALK_NODES) {
    const current = queue.shift();

    if (current.visible === false) continue;

    typeCounts[current.type] = (typeCounts[current.type] || 0) + 1;
    typeSequence.push(current.type);

    const lowerName = (current.name || "").toLowerCase();
    if (!isGenericName(current.name)) {
      names.push(lowerName);
    }

    addPaints(current, colors);

    if (current.type === "TEXT" && current.characters) {
      textParts.push(current.characters);
      hasText = true;
    }

    if (current.type === "COMPONENT") {
      componentKeys.push(current.key);
      if (current.id !== node.id) hasNestedComponentChild = true;

      try {
        if (current.parent && current.parent.type === "COMPONENT_SET") {
          componentSetKeys.push(current.parent.key);
        }
      } catch (error) {
        // Parent may be unavailable for detached/library nodes.
      }
    }

    if (current.type === "INSTANCE") {
      if (current.id !== node.id) hasNestedComponentChild = true;

      try {
        if (current.mainComponent) {
          componentKeys.push(current.mainComponent.key);

          if (
            current.mainComponent.parent &&
            current.mainComponent.parent.type === "COMPONENT_SET"
          ) {
            componentSetKeys.push(current.mainComponent.parent.key);
          }
        }
      } catch (error) {
        // Some library components can be unavailable locally.
      }
    }

    if (current.id !== node.id) {
      childCount += 1;
    }

    if (canHaveChildren(current)) {
      for (const child of current.children) {
        if (childCount < MAX_WALK_NODES) queue.push(child);
      }
    }
  }

  const width = Math.round(node.width || 0);
  const height = Math.round(node.height || 0);

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    family: getNodeFamily(node.type),
    text: textParts.join(" ").toLowerCase(),
    width,
    height,
    directChildCount: canHaveChildren(node) ? node.children.length : 0,
    typeCounts,
    componentKeys,
    componentSetKeys,
    names,
    colors,
    typeSequence,
    childCount,
    isIcon: computeIsIcon(typeCounts, width, height, hasText, hasNestedComponentChild)
  };
}

function scoreCandidate(target, candidate) {
  if (!isCoarselyCompatible(target, candidate)) {
    return { score: 0, reasons: [] };
  }

  let score = 0;
  const reasons = [];

  if (target.type === candidate.type) {
    score += 12;
    reasons.push("Same layer type");
  } else {
    score += 5;
    reasons.push("Same layer family");
  }

  const candidateComponents = new Set(candidate.componentKeys);
  const sharedComponents = [...new Set(target.componentKeys)].filter((key) =>
    candidateComponents.has(key)
  );

  if (sharedComponents.length > 0) {
    score += Math.min(36, 22 + sharedComponents.length * 7);
    reasons.push("Same component lineage");
  } else {
    const candidateComponentSets = new Set(candidate.componentSetKeys);
    const sharedComponentSets = [...new Set(target.componentSetKeys)].filter((key) =>
      candidateComponentSets.has(key)
    );

    if (sharedComponentSets.length > 0) {
      score += 16;
      reasons.push("Same component (different variant)");
    }
  }

  const textScore = jaccard(words(target.text), words(candidate.text));
  if (textScore > 0) {
    score += Math.round(textScore * 20);
    reasons.push("Similar text");
  }

  const nameScore = jaccard(
    new Set(target.names.flatMap((name) => [...words(name)])),
    new Set(candidate.names.flatMap((name) => [...words(name)]))
  );
  if (nameScore > 0) {
    score += Math.round(nameScore * 10);
    reasons.push("Similar layer names");
  }

  const structureSimilarity = typeCountSimilarity(target.typeCounts, candidate.typeCounts);
  if (structureSimilarity > 0.25) {
    score += Math.round(structureSimilarity * 25);
    reasons.push("Layer structure");
  }

  const orderSimilarity = sequenceSimilarity(target.typeSequence, candidate.typeSequence);
  if (orderSimilarity > 0.55) {
    score += Math.round(orderSimilarity * 10);
    reasons.push("Similar structure order");
  }

  const colorScore = jaccard(new Set(target.colors), new Set(candidate.colors));
  if (colorScore > 0) {
    score += Math.round(colorScore * 14);
    reasons.push("Similar colors");
  }

  // Large frames (full screens/breakpoints) commonly share a width purely
  // because of a common device size, not because they're the same design.
  // Damp the size/ratio signal for big containers so that isn't mistaken
  // for real similarity.
  const isLargeContainer =
    target.family === "container" && (target.width > 800 || target.height > 800);
  const sizeWeight = isLargeContainer ? 0.4 : 1;

  const sizeSimilarity =
    (closeness(target.width, candidate.width) + closeness(target.height, candidate.height)) / 2;
  if (sizeSimilarity > 0.75 && !isLargeContainer) {
    reasons.push("Similar size");
  }
  score += Math.round(sizeSimilarity * 14 * sizeWeight);

  const targetRatio =
    target.width && target.height ? target.width / target.height : 0;

  const candidateRatio =
    candidate.width && candidate.height
      ? candidate.width / candidate.height
      : 0;

  if (
    targetRatio &&
    candidateRatio
  ) {
    const ratioSimilarity = Math.max(0, 1 - Math.abs(targetRatio - candidateRatio));
    score += Math.round(ratioSimilarity * 9 * sizeWeight);
    if (ratioSimilarity > 0.82 && !isLargeContainer) {
      reasons.push("Similar proportions");
    }
  }

  if (target.family === "container") {
    const layerCountSimilarity = closeness(target.childCount, candidate.childCount);
    const directLayerSimilarity = closeness(target.directChildCount, candidate.directChildCount);
    score += Math.round(layerCountSimilarity * 9);
    score += Math.round(directLayerSimilarity * 7);
    if (layerCountSimilarity > 0.75 || directLayerSimilarity > 0.75) {
      reasons.push("Similar layer count");
    }
  }

  if (target.isIcon && candidate.isIcon) {
    const vectorCountSimilarity = closeness(
      getVectorCount(target.typeCounts),
      getVectorCount(candidate.typeCounts)
    );
    score += Math.round(vectorCountSimilarity * 20);
    if (vectorCountSimilarity > 0.9) {
      reasons.push("Same icon shape");
    }
  }

  return {
    score: Math.min(score, 100),
    reasons: [...new Set(reasons)]
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

async function getSearchRoots(target) {
  const pool = [];
  let visited = 0;

  async function walk(page, node) {
    if (pool.length >= MAX_CANDIDATE_POOL) return;
    if (node.visible === false) return;

    visited += 1;
    if (visited % WALK_YIELD_INTERVAL === 0) {
      await wait();
    }

    if (shouldConsiderAsCandidate(target, node)) {
      pool.push({
        page,
        node,
        roughScore: getRoughCandidateScore(target, node)
      });
    }

    if (canHaveChildren(node)) {
      for (const child of node.children) await walk(page, child);
    }
  }

  for (const page of figma.root.children) {
    for (const child of page.children) await walk(page, child);
  }

  pool.sort((a, b) => b.roughScore - a.roughScore);
  return pool.slice(0, MAX_CANDIDATES).map(({ page, node }) => ({ page, node }));
}

function isDescendantOf(node, potentialAncestorNode) {
  let current = node.parent;
  while (current) {
    if (current.id === potentialAncestorNode.id) return true;
    current = current.parent;
  }
  return false;
}

function dedupeOverlappingMatches(rawMatches) {
  const sorted = [...rawMatches].sort((a, b) => b.score - a.score);
  const kept = [];

  for (const candidate of sorted) {
    const overlapsKeptMatch = kept.some(
      (existing) =>
        isDescendantOf(candidate.node, existing.node) ||
        isDescendantOf(existing.node, candidate.node)
    );

    if (!overlapsKeptMatch) kept.push(candidate);
  }

  return kept;
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

  await figma.loadAllPagesAsync();

  const target = collectNodeInfo(selected);
  const roots = await getSearchRoots(target);
  const rawMatches = [];
  const minScore = getMinScore(target);

  for (let index = 0; index < roots.length; index += 1) {
    const item = roots[index];
    const candidate = collectNodeInfo(item.node);

    if (!isCoarselyCompatible(target, candidate)) {
      continue;
    }

    const result = scoreCandidate(target, candidate);

    if (result.score >= minScore) {
      rawMatches.push({
        node: item.node,
        id: item.node.id,
        pageId: item.page.id,
        name: item.node.name,
        page: item.page.name,
        type: item.node.type,
        width: candidate.width,
        height: candidate.height,
        layers: candidate.childCount,
        score: result.score,
        reasons: result.reasons.slice(0, 3)
      });
    }

    if (index > 0 && index % CHUNK_SIZE === 0) {
      const progress = Math.round((index / roots.length) * 100);
      figma.ui.postMessage({ type: "scan-progress", progress });
      await wait();
    }
  }

  const deduped = dedupeOverlappingMatches(rawMatches);
  deduped.sort((a, b) => b.score - a.score);
  const matches = deduped.map(({ node, ...rest }) => rest);

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

function getNodePage(node) {
  let current = node;
  while (current && current.type !== "PAGE") {
    current = current.parent;
  }
  return current;
}

function getAbsolutePosition(node) {
  const transform = node.absoluteTransform;
  return { x: transform[0][2], y: transform[1][2] };
}

const ANNOTATION_PLUGIN_DATA_KEY = "designTraceMatchId";
const ANNOTATION_FONT_SIZE = 40;

function removeAnnotation(matchId) {
  const existing = figma.root.findOne(
    (node) => node.getPluginData && node.getPluginData(ANNOTATION_PLUGIN_DATA_KEY) === matchId
  );
  if (existing) existing.remove();
}

async function createAnnotation(node, matchId, layerName, text, color) {
  const page = getNodePage(node) || figma.currentPage;
  const position = getAbsolutePosition(node);

  await figma.loadFontAsync({ family: "Inter", style: "Bold" });

  const label = figma.createText();
  label.name = layerName;
  label.setPluginData(ANNOTATION_PLUGIN_DATA_KEY, matchId);
  label.characters = text;
  label.fontName = { family: "Inter", style: "Bold" };
  label.fontSize = ANNOTATION_FONT_SIZE;
  label.fills = [{ type: "SOLID", color }];
  label.x = position.x;
  label.y = position.y - ANNOTATION_FONT_SIZE * 1.4;

  page.appendChild(label);
}

async function flagMatch(match) {
  const node = figma.root.findOne((item) => item.id === match.id);

  if (!node) {
    figma.notify("Could not find that match anymore.");
    figma.ui.postMessage({ type: "flag-failed", message: "Could not find that match anymore." });
    return;
  }

  try {
    removeAnnotation(match.id);
    await createAnnotation(
      node,
      match.id,
      "Design Trace - Review Needed 🚩",
      "🚩 Review Needed",
      { r: 0.75, g: 0.15, b: 0.13 }
    );

    figma.ui.postMessage({
      type: "flagged",
      match
    });
  } catch (error) {
    figma.notify("Could not flag that match.");
    figma.ui.postMessage({ type: "flag-failed", message: "Could not flag that match." });
  }
}

async function markReviewed(match) {
  const node = figma.root.findOne((item) => item.id === match.id);

  if (!node) {
    figma.notify("Could not find that match anymore.");
    figma.ui.postMessage({ type: "flag-failed", message: "Could not find that match anymore." });
    return;
  }

  try {
    removeAnnotation(match.id);
    await createAnnotation(
      node,
      match.id,
      "Design Trace - Reviewed ✅",
      "✅ Reviewed",
      { r: 0.06, g: 0.62, b: 0.33 }
    );

    figma.ui.postMessage({
      type: "reviewed",
      match
    });
  } catch (error) {
    figma.notify("Could not mark that match as reviewed.");
    figma.ui.postMessage({ type: "flag-failed", message: "Could not mark that match as reviewed." });
  }
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

  if (message.type === "mark-reviewed") {
    await markReviewed(message.match);
  }

  if (message.type === "resize") {
    figma.ui.resize(message.width, message.height);
  }

  if (message.type === "close") {
    figma.closePlugin();
  }
};
