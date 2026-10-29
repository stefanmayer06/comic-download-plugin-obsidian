/** How a page is adjusted for the screen; see PageLookSettings for the stored percentages. */
export interface PageLook {
	/** 1 leaves colours as they are, 1.4 makes them 40% stronger. */
	saturation: number;
	/** 1 leaves contrast as it is; higher spreads tones away from mid-grey. */
	contrast: number;
	/** Gamma for mid-tones: 1 leaves them, higher darkens them. */
	gamma: number;
	/** Strength of the sharpening, 0 for none. */
	sharpness: number;
}

/** The page as the file has it. */
export const ORIGINAL_LOOK: PageLook = { saturation: 1, contrast: 1, gamma: 1, sharpness: 0 };

/** The device pixels a page is drawn into. */
export interface PageBox {
	width: number;
	height: number;
	/** Fill the width and let the page run taller than the box. */
	fitWidth: boolean;
}

/** Milliseconds of adjusting between pauses, so the reader stays responsive while a neighbour page renders. */
const SLICE_MS = 40;
/** The tone curve also covers values sharpening pushes below 0 or above 255, so lookups need no clamping. */
const CURVE_OFFSET = 512;

/**
 * Decodes a page and draws it at exactly the device pixels it covers, so
 * the screen shows it 1:1 rather than the web view shrinking it on the fly,
 * which softens line art. Then, unless the look is ORIGINAL_LOOK, adjusts
 * it: colour e-ink screens show pages paler, lighter and softer than the
 * file, which stronger colours, darker mid-tones and sharpening make up for.
 */
export async function renderPage(blob: Blob, box: PageBox, look: PageLook): Promise<ImageBitmap> {
	const source = await createImageBitmap(blob);
	const scale = box.fitWidth ? box.width / source.width : Math.min(box.width / source.width, box.height / source.height);
	const width = Math.max(1, Math.round(source.width * scale));
	const height = Math.max(1, Math.round(source.height * scale));

	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) throw new Error("Canvas is not available");
	const scaled = await createImageBitmap(source, { resizeWidth: width, resizeHeight: height, resizeQuality: "high" });
	source.close();
	context.drawImage(scaled, 0, 0, width, height);
	scaled.close();

	if (!isOriginal(look)) {
		const image = context.getImageData(0, 0, width, height);
		await adjust(image, look);
		context.putImageData(image, 0, 0);
	}
	const bitmap = await createImageBitmap(canvas);
	canvas.width = canvas.height = 0;
	return bitmap;
}

function isOriginal(look: PageLook): boolean {
	return look.saturation === 1 && look.contrast === 1 && look.gamma === 1 && look.sharpness === 0;
}

/**
 * Sharpens with an unsharp mask (each value pushed away from the average
 * of its four neighbours), then applies contrast and gamma through a tone
 * curve, then saturation around each pixel's luminance.
 */
async function adjust(image: ImageData, look: PageLook): Promise<void> {
	const { width, height, data } = image;
	const curve = new Float32Array(256 + 2 * CURVE_OFFSET);
	for (let index = 0; index < curve.length; index++) {
		const value = Math.min(255, Math.max(0, index - CURVE_OFFSET));
		const contrasted = Math.min(1, Math.max(0, (value / 255 - 0.5) * look.contrast + 0.5));
		curve[index] = 255 * contrasted ** look.gamma;
	}
	const { saturation } = look;
	// An unsharp mask: each value plus k times its difference from its four neighbours' average.
	const centre = 1 + look.sharpness;
	const neighbour = look.sharpness / 4;
	// Sharpening reads the original neighbours, so it needs a copy to read from.
	const source = look.sharpness > 0 ? data.slice() : data;
	const row = width * 4;

	let sliceStart = performance.now();
	for (let y = 0; y < height; y++) {
		const sharpenRow = look.sharpness > 0 && y > 0 && y < height - 1;
		for (let x = 0, i = y * row; x < width; x++, i += 4) {
			let r = source[i];
			let g = source[i + 1];
			let b = source[i + 2];
			if (sharpenRow && x > 0 && x < width - 1) {
				r = centre * r - neighbour * (source[i - 4] + source[i + 4] + source[i - row] + source[i + row]);
				g = centre * g - neighbour * (source[i - 3] + source[i + 5] + source[i + 1 - row] + source[i + 1 + row]);
				b = centre * b - neighbour * (source[i - 2] + source[i + 6] + source[i + 2 - row] + source[i + 2 + row]);
			}
			r = curve[(r + CURVE_OFFSET) | 0];
			g = curve[(g + CURVE_OFFSET) | 0];
			b = curve[(b + CURVE_OFFSET) | 0];
			const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			data[i] = luminance + saturation * (r - luminance);
			data[i + 1] = luminance + saturation * (g - luminance);
			data[i + 2] = luminance + saturation * (b - luminance);
		}
		if (performance.now() - sliceStart > SLICE_MS) {
			await new Promise((resolve) => window.setTimeout(resolve, 0));
			sliceStart = performance.now();
		}
	}
}
