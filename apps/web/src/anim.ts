/**
 * Animated values shared between the scene, the label overlay and the viewport capture. In a module of its own so
 * the state module (which needs it for captures) does not pull in the whole scene and, through it, the toolbar.
 */
export const anim = { explode: 0, settleAt: 0 };
