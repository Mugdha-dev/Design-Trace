figma.showUI(__html__, {
  width: 360,
  height: 520,
  themeColors: true
});

function getSelectedLayer() {
  const selected = figma.currentPage.selection[0];

  if (!selected) {
    figma.ui.postMessage({
      type: "no-selection"
    });
    return;
  }

  figma.ui.postMessage({
    type: "selection-found",
    layer: {
      id: selected.id,
      name: selected.name,
      type: selected.type,
      width: Math.round(selected.width || 0),
      height: Math.round(selected.height || 0),
      pageName: figma.currentPage.name
    }
  });
}

figma.ui.onmessage = (message) => {
  if (message.type === "check-selection") {
    getSelectedLayer();
  }

  if (message.type === "close") {
    figma.closePlugin();
  }
};