/**
 * Engine facade — the only module the UI imports from. "No molstar/* import outside
 * src/engine/" is then a single grep.
 */

export { Viewer, DEFAULT_COLOR, enableEngineDebug } from './viewer';
export { loadBytes, loadFromPdbId, loadFromUniProt, setModelIndex, renameStructure, renameChain, setChainRole, detectFormat } from './load';
export {
    applyDefaultPreset,
    clearPaint,
    colorTarget,
    layerSummary,
    removeStructure,
    setChainColor,
    setColorSettings,
    setLayer,
    setLayerOpacity,
    layerOpacities,
    setTransparency,
    setEmissive,
    clearEmissive,
    setVisible,
    refreshColors,
    setChainPalette,
} from './style';
export { chainColor, COLOR_SCHEME_LABELS } from './coloring';
export {
    clearFocus,
    clearSelection,
    expandToChains,
    expandToResidues,
    focusSelection,
    invertSelection,
    onSelectionChange,
    selectAll,
    selectAround,
    selectBySpec,
    selectChain,
    selectClass,
    selectHetero,
    selectedResidues,
    selectInterface,
    selectionSummary,
    selectResidues,
    setPickLevel,
    setPointerMode,
    styleFocusView,
    trackFocusColors,
    refreshFocusView,
    promoteSelection,
    demoteSelection,
    SELECTION_LEVEL_NAMES,
} from './selection';
export type { PointerMode, SelectionLevel } from './selection';
export { parseSpec } from './spec';
export { superposeChains, resetSuperposition, measureChains } from './compare';
export { focusStructure, resetView, restoreClipRadius, rotateView, setClip, setProjection, setRock, setSpin } from './camera';
export {
    APP_BACKGROUND,
    applyLook,
    applyLookPreset,
    backgroundBase,
    cloneLook,
    DEFAULT_LOOK,
    getLook,
    illuminationSupported,
    LOOK_PRESETS,
    mixColor,
    presetLook,
    tuneLook,
} from './look';
export type { LookDefinition } from './look';
export { canonicalView, dockingAxes, CANONICAL_VIEW_LABELS } from './views';
export type { CanonicalView, DockingAxes } from './views';
export { fadeByDistance, clearFade, paintFootprint, clearFootprint, DEFAULT_FADE } from './fade';
export type { FadeOptions, FootprintOptions, FigureReference } from './fade';
export { maxImageSize, pixelsForPrint, renderImage, renderMovie, viewportSize } from './snapshot';
export type { ImageRequest, MovieFrame, MovieRequest } from './snapshot';
export { startMeasuring, removeMeasurement, clearMeasurements, captureSelection, capturedSides, measureBetweenSelections, clearPairMeasure } from './measure';
export type { PairMeasure } from './measure';
export { analyzeInterface, showInteractions, hideInteractions, showInteractionAtoms, hideInteractionAtoms, contactsPerChain, residueLabel, DEFAULT_CONTACTS, interfaceSecondaryStructure } from './interface';
export type { ChainContacts, InterfaceSsReport, InterfaceSsResidue, SsClass } from './interface';
export type { ContactOptions } from './interface';
export { CHAIN_ROLE_LABELS } from './describe';
export * from './types';
export { applyRigidTransform } from './compare';
export { setHydrogenDisplay } from './style';
export type { HydrogenDisplay } from './viewer';
export { setOverlay, clearOverlay, setOverlayVisible, pruneOverlays } from './overlay';
export type { OverlayLine, OverlaySphere, Point } from './overlay';
export { atomPositions, residueCentroids } from './atoms';
export type { AtomSpec } from './atoms';
export { setDataset, datasetsOf, showDataset, updateDataset } from './datasets';
export { datasetColors, datasetDomain, datasetClipped, rampColor } from './coloring';
export { showPotential, stylePotential, removePotential, hasPotential, setPotentialVisible, DEFAULT_POTENTIAL_STYLE } from './potential';
export type { PotentialStyle } from './potential';
export {
    showCavities,
    styleCavities,
    setCavityVisible,
    soloCavity,
    focusCavity,
    removeCavities,
    cavitySetStyle,
    cavityColor,
    CAVITY_PALETTE,
    DEFAULT_CAVITY_STYLE,
} from './cavities';
export type { CavityStyle, CavityRepr, CavityColorMode } from './cavities';
export { computeInput } from './export';
export { captureScene, restoreScene } from './history';
export { labelSelection, clearLabels, DEFAULT_LABEL_STYLE } from './labels';
export type { LabelStyle, LabelContent } from './labels';
export type { SceneSnapshot } from './history';
export type { ComputeInput } from './export';
