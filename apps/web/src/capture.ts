import { anim } from './anim';

const MAX_WIDTH = 1024;
/** A .jarvis file's thumbnail: a PNG this wide at most. */
const THUMBNAIL_WIDTH = 512;
const SETTLE_TIMEOUT_MS = 4000;

function settled(target: number): boolean {
    return performance.now() >= anim.settleAt && Math.abs(anim.explode - target) < 0.01;
}

/**
 * The 3D viewport as base64, taken once camera and explode animations have settled; null without a canvas. A JPEG, or
 * with `png` a smaller PNG (the thumbnail of a .jarvis file).
 */
export async function captureViewport(targetExplode: number, options: { png?: boolean } = {}): Promise<string | null> {
    // Timers, not animation frames: a background tab still has to answer.
    const deadline = performance.now() + SETTLE_TIMEOUT_MS;
    do {
        await new Promise((resolve) => window.setTimeout(resolve, 150));
    } while (!settled(targetExplode) && performance.now() < deadline);

    const source = document.querySelector<HTMLCanvasElement>('canvas[data-engine]');
    if (!source || source.width === 0) {
        return null;
    }
    const scale = Math.min(1, (options.png ? THUMBNAIL_WIDTH : MAX_WIDTH) / source.width);
    const copy = document.createElement('canvas');
    copy.width = Math.round(source.width * scale);
    copy.height = Math.round(source.height * scale);
    copy.getContext('2d')!.drawImage(source, 0, 0, copy.width, copy.height);
    return (options.png ? copy.toDataURL('image/png') : copy.toDataURL('image/jpeg', 0.85)).split(',')[1] ?? null;
}
