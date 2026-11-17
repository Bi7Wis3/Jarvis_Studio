// Assembly mates: the stored data (types.ts), which mates a pair of entities takes (valid.ts), their equations
// (residuals.ts), the solver (solver.ts) and the edits the tree, the form and the assistant make (edit.ts).

export * from './types';
export * from './valid';
export { anchorOf, axisOf, centreOf, directionOf, mateRows, worldGeom, type Side } from './residuals';
export { refGeometry, refLabel } from './resolve';
export { fixedParts, HOLDS, MateSystem, solveAssembly, type AssemblyResult, type DragTarget, type SolveOptions } from './solver';
export * from './edit';
export { compose, copyTransform, eulerToMat, matToEuler, placementOf, rigidOf, type Rigid } from './math';
