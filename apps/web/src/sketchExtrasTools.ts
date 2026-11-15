// The toolbar entries of sketch text, sketch picture, equation driven curve, blocks and spline fitting.

import type { ToolDef } from './toolDefs';
import { sketchTextTool } from './sketchTextForm';
import { sketchPictureTool } from './sketchPictureForm';
import { equationCurveTool } from './sketchEquationForm';
import { blockTools } from './sketchBlockForms';
import { splineFitTools } from './sketchSplineFitForms';
import { splineTools } from './sketchSplineForms';

/** Draw group: entities made from typed values. */
export const extrasDrawTools: ToolDef[] = [sketchTextTool, sketchPictureTool, equationCurveTool];

/** Modify group. */
export const extrasModifyTools: ToolDef[] = [...splineFitTools, ...splineTools, ...blockTools];
