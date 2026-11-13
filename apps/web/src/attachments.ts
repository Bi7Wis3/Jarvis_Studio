import type { ImageAttachment } from '@jarvis/core';

const MAX_SIDE = 1568;

/** Reads a pasted or dropped image, scaled down to what the model can use, as base64 JPEG. */
export async function readImage(file: File): Promise<ImageAttachment & { preview: string }> {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const preview = canvas.toDataURL('image/jpeg', 0.85);
    return { data: preview.slice(preview.indexOf(',') + 1), mimeType: 'image/jpeg', preview };
}

/** Image files from a paste or drop, if any. */
export function imageFiles(data: DataTransfer | null): File[] {
    return data ? [...data.files].filter((file) => file.type.startsWith('image/')) : [];
}
