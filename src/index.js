import queryString from 'query-string';

import { Resvg } from '@cf-wasm/resvg';
import encodeWebp, { init as initWebpWasm } from '@jsquash/webp/encode';
import * as photon from '@silvia-odwyer/photon';

import FONT_DATA from './font.ttf';
import WEBP_ENC_WASM from '../node_modules/@jsquash/webp/codec/enc/webp_enc.wasm';
import PHOTON_WASM from '../node_modules/@silvia-odwyer/photon/photon_rs_bg.wasm';

// 图片处理
const photonInstance = await WebAssembly.instantiate(PHOTON_WASM, {
	'./photon_rs_bg.js': photon,
});
photon.setWasm(photonInstance.exports); // need patch

await initWebpWasm(WEBP_ENC_WASM);

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

const parseNumber = (value, fallback) => {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
};

const escapeXml = (value) =>
	String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');

const estimateTextOverlaySize = ({ lines, fontSize, paddingX, paddingY }) => {
	// Simple heuristic (Roboto-ish): average glyph width ≈ 0.6 * fontSize
	const maxLineLength = Math.max(0, ...lines.map((line) => line.length));
	const textWidth = Math.ceil(maxLineLength * fontSize * 0.6);
	const lineHeight = Math.ceil(fontSize * 1.25);
	const textHeight = Math.max(1, lines.length) * lineHeight;
	return {
		width: Math.max(1, textWidth + paddingX * 2),
		height: Math.max(1, textHeight + paddingY * 2),
		lineHeight,
	};
};

const buildSvgText = ({
	text,
	width,
	height,
	paddingX,
	paddingY,
	fontSize,
	lineHeight,
	fill,
	opacity,
	stroke,
	strokeWidth,
	textAnchor,
}) => {
	const safeFill = fill || '#FFFFFF';
	const safeOpacity = clampNumber(opacity ?? 1, 0, 1);
	const safeStroke = stroke || 'none';
	const safeStrokeWidth = Math.max(0, strokeWidth || 0);

	const lines = String(text ?? '').split('\n');
	// x depends on anchor
	const x = textAnchor === 'end' ? width - paddingX : paddingX;
	const y0 = paddingY + fontSize; // baseline-ish

	const tspans = lines
		.map((line, idx) => {
			const dy = idx === 0 ? 0 : lineHeight;
			return `<tspan x="${x}" dy="${dy}">${escapeXml(line)}</tspan>`;
		})
		.join('');

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <style>
    @font-face {
      font-family: "CustomFont";
      src: local("Monaco");
    }
  </style>
  <rect x="0" y="0" width="${width}" height="${height}" fill="none" stroke="green" stroke-width="10" />
  <text
    x="${x}"
    y="${y0}"
    font-family="CustomFont, Monaco, sans-serif"
    font-size="${fontSize}"
    fill="${escapeXml(safeFill)}"
    fill-opacity="${safeOpacity}"
    stroke="${escapeXml(safeStroke)}"
    stroke-width="${safeStrokeWidth}"
    text-anchor="${textAnchor}"
  >${tspans}</text>
</svg>`;
};

const drawSvgText = (inputImage, rawParams) => {
	// Supported:
	// - Corner: draw_svg_text!text,br|bl,marginX,marginY,fontSize,fill,opacity,stroke,strokeWidth
	// - Absolute: draw_svg_text!text,x,y,fontSize,fill,opacity,stroke,strokeWidth
	//
	// Notes:
	// - If using hex colors, encode `#` as `%23` in the URL.
	const [
		rawText = '',
		rawPositionOrX = 'br',
		rawMarginXOrY = '16',
		rawMarginYOrFontSize = '16',
		rawFontSizeOrFill = '32',
		rawFillOrOpacity = '#FFFFFF',
		rawOpacityOrStroke = '0.8',
		rawStrokeOrStrokeWidth = 'none',
		rawStrokeWidth = '0',
	] = rawParams;

	const text = String(rawText ?? '');
	if (!text) return inputImage;
	const imageData = inputImage.get_image_data();
	const baseWidth = imageData.width;
	const baseHeight = imageData.height;

	const isCorner = rawPositionOrX === 'br' || rawPositionOrX === 'bl';

	let x = 0;
	let y = 0;
	let fontSize;
	let fill;
	let opacity;
	let stroke;
	let strokeWidth;
	let marginX;
	let marginY;
	let textAnchor;

	if (isCorner) {
		marginX = Math.max(0, parseNumber(rawMarginXOrY, 16));
		marginY = Math.max(0, parseNumber(rawMarginYOrFontSize, 16));
		fontSize = clampNumber(parseNumber(rawFontSizeOrFill, 32), 8, 512);
		fill = String(rawFillOrOpacity ?? '#FFFFFF');
		opacity = clampNumber(parseNumber(rawOpacityOrStroke, 0.8), 0, 1);
		stroke = String(rawStrokeOrStrokeWidth ?? 'none');
		strokeWidth = Math.max(0, parseNumber(rawStrokeWidth, 0));
		textAnchor = rawPositionOrX === 'br' ? 'end' : 'start';
	} else {
		// absolute x,y
		x = Math.floor(parseNumber(rawPositionOrX, 0));
		y = Math.floor(parseNumber(rawMarginXOrY, 0));
		fontSize = clampNumber(parseNumber(rawMarginYOrFontSize, 32), 8, 512);
		fill = String(rawFontSizeOrFill ?? '#FFFFFF');
		opacity = clampNumber(parseNumber(rawFillOrOpacity, 0.8), 0, 1);
		stroke = String(rawOpacityOrStroke ?? 'none');
		strokeWidth = Math.max(0, parseNumber(rawStrokeOrStrokeWidth, 0));
		textAnchor = 'start';
	}

	const lines = text.split('\n');

	x = Math.max(0, x);
	y = Math.max(0, y);

	const maxOverlayWidth = Math.max(
		1,
		isCorner ? Math.floor(baseWidth - marginX) : Math.floor(baseWidth - x)
	);
	const maxOverlayHeight = Math.max(
		1,
		isCorner ? Math.floor(baseHeight - marginY) : Math.floor(baseHeight - y)
	);

	let paddingX;
	let paddingY;
	let overlayWidth;
	let overlayHeight;
	let lineHeight;
	for (let i = 0; i < 32; i += 1) {
		paddingX = Math.ceil(fontSize * 0.4);
		paddingY = Math.ceil(fontSize * 0.35);
		const estimated = estimateTextOverlaySize({
			lines,
			fontSize,
			paddingX,
			paddingY,
		});
		overlayWidth = estimated.width;
		overlayHeight = estimated.height;
		lineHeight = estimated.lineHeight;
		if (overlayWidth <= maxOverlayWidth && overlayHeight <= maxOverlayHeight) break;
		if (fontSize <= 8) break;
		fontSize = Math.max(8, fontSize - 2);
	}

	if (isCorner) {
		if (rawPositionOrX === 'br') {
			x = baseWidth - overlayWidth - Math.floor(marginX);
		} else {
			x = Math.floor(marginX);
		}
		y = baseHeight - overlayHeight - Math.floor(marginY);
	}

	const maxX = Math.max(0, baseWidth - overlayWidth);
	const maxY = Math.max(0, baseHeight - overlayHeight);
	x = Math.floor(clampNumber(x, 0, maxX));
	y = Math.floor(clampNumber(y, 0, maxY));

	const svg = buildSvgText({
		text,
		width: overlayWidth,
		height: overlayHeight,
		paddingX,
		paddingY,
		fontSize,
		lineHeight,
		fill,
		opacity,
		stroke,
		strokeWidth,
		textAnchor,
	});

	console.log('SVG content length:', svg.length);
	console.log('FONT_DATA exists:', !!FONT_DATA);
	if (FONT_DATA) {
		console.log('FONT_DATA byteLength:', FONT_DATA.byteLength || FONT_DATA.size);
	}

	const resvg = new Resvg(svg, {
		fitTo: { mode: 'original' },
		font: {
			fontDb: [new Uint8Array(FONT_DATA)],
			loadSystemFonts: false,
			defaultFontFamily: 'CustomFont',
		},
	});
	const pngBuffer = resvg.render().asPng();
	console.log('Rendered PNG size:', pngBuffer.byteLength);

	const overlay = photon.PhotonImage.new_from_byteslice(new Uint8Array(pngBuffer));
	try {
		console.log(`Applying watermark at (${x}, ${y}) on base image ${baseWidth}x${baseHeight}`);
		photon.watermark(inputImage, overlay, x, y);
	} finally {
		overlay.ptr && overlay.free();
	}

	return inputImage;
};

const OUTPUT_FORMATS = {
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
};

const multipleImageMode = ['watermark', 'blend'];

const inWhiteList = (env, url) => {
	const imageUrl = new URL(url);
	const whiteList = env.WHITE_LIST ? env.WHITE_LIST.split(',') : [];
	return !(whiteList.length && !whiteList.find((hostname) => imageUrl.hostname.endsWith(hostname)));
};

const processImage = async (env, request, inputImage, pipeAction) => {
	const [action, options = ''] = pipeAction.split('!');
	const params = options.split(',');
	if (action === 'draw_svg_text') {
		return drawSvgText(inputImage, params);
	}
	if (multipleImageMode.includes(action)) {
		const image2 = params.shift(); // 是否需要 decodeURIComponent ?
		if (image2 && inWhiteList(env, image2)) {
			const image2Res = await fetch(image2, { headers: request.headers });
			if (image2Res.ok) {
				const inputImage2 = photon.PhotonImage.new_from_byteslice(new Uint8Array(await image2Res.arrayBuffer()));
				// 多图处理是处理原图
				photon[action](inputImage, inputImage2, ...params);
				inputImage2.ptr && inputImage2.free();
				return inputImage; // 多图模式返回第一张图
			}
		}
	} else {
		return photon[action](inputImage, ...params);
	}
};

export default {
	async fetch(request, env, context) {
		// 匹配缓存
		const cacheUrl = new URL(request.url);
		const cacheKey = new Request(cacheUrl.toString());
		const cache = caches.default;
		let hasCache = await cache.match(cacheKey);

		// 调试期间：如果是绘制文本，强制不使用缓存以观察效果
		if (queryString.parse(cacheUrl.search).action?.includes('draw_svg_text')) {
			hasCache = null;
		}

		if (hasCache) {
			console.log('cache: true');
			return hasCache;
		}

		// 入参提取与校验
		const query = queryString.parse(new URL(request.url).search);
		const { url = '', action = '', format = 'webp', quality = 99 } = query;
		console.log('params:', url, action, format, quality);

		if (!url) {
			return new Response(null, {
				status: 302,
				headers: {
					location: 'https://meaningslab.com',
				},
			});
		}

		// 白名单检查
		if (!inWhiteList(env, url)) {
			console.log('whitelist: false');
			return new Response(null, {
				status: 403,
			});
		}

		// 目标图片获取与检查
		// 避免转发 If-Modified-Since / If-None-Match，否则源站返回 304 会导致 Worker 无法获取图片数据进行处理
		const fetchHeaders = new Headers(request.headers);
		fetchHeaders.delete('if-modified-since');
		fetchHeaders.delete('if-none-match');

		const imageRes = await fetch(url, { headers: fetchHeaders });
		if (!imageRes.ok) {
			return imageRes;
		}
		console.log('fetch image done');

		const imageBytes = new Uint8Array(await imageRes.arrayBuffer());
		try {
			const inputImage = photon.PhotonImage.new_from_byteslice(imageBytes);
			console.log('create inputImage done');

			/** pipe
			 * `resize!800,400,1|watermark!https%3A%2F%2Fmt.ci%2Flogo.png,10,10,10,10`
			 */
			const pipe = action.split('|');
			const outputImage = await pipe.filter(Boolean).reduce(async (result, pipeAction) => {
				result = await result;
				return (await processImage(env, request, result, pipeAction)) || result;
			}, inputImage);
			console.log('create outputImage done');

			// 图片编码
			let outputImageData;
			if (format === 'jpeg' || format === 'jpg') {
				outputImageData = outputImage.get_bytes_jpeg(quality)
			} else if (format === 'png') {
				outputImageData = outputImage.get_bytes()
			} else {
				outputImageData = await encodeWebp(outputImage.get_image_data(), { quality });
			}
			console.log('create outputImageData done');

			// 返回体构造
			const imageResponse = new Response(outputImageData, {
				headers: {
					'content-type': OUTPUT_FORMATS[format],
					'cache-control': 'public,max-age=15552000,s-maxage=15552000',
				},
			});

			// 释放资源
			inputImage.ptr && inputImage.free();
			outputImage.ptr && outputImage.free();
			console.log('image free done');

			// 写入缓存
			context.waitUntil(cache.put(cacheKey, imageResponse.clone()));
			return imageResponse;
		} catch (error) {
			console.error('process:error', error.name, error.message, error);
			const errorResponse = new Response(imageBytes || null, {
				headers: imageRes.headers,
				status: 'RuntimeError' === error.name ? 415 : 500,
			});
			return errorResponse;
		}
	},
};
