import queryString from 'query-string';

// 移除不再需要的 resvg 和字体
// import { Resvg, initWasm as initResvgWasm } from '@cf-wasm/resvg';
// import FONT_DATA from './font.ttf';
import * as photon from '@silvia-odwyer/photon';
import encodeWebp, { init as initWebpWasm } from '@jsquash/webp/encode';

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

	const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800">
  
</svg>`;
	console.log('Final SVG for Debug:', svg);
	return svg;
};

const drawSvgText = (inputImage, rawParams) => {
	const [
		rawText = '',
		rawPositionOrX = 'br',
		rawMarginXOrY = '24',
		rawMarginYOrFontSize = '24',
		rawFontSize = '48',
	] = rawParams;

	const text = String(rawText);
	if (!text) return inputImage;

	const imageData = inputImage.get_image_data();
	const baseWidth = imageData.width;
	const baseHeight = imageData.height;

	const isCorner = rawPositionOrX === 'br' || rawPositionOrX === 'bl';

	let x = 0;
	let y = 0;

	if (isCorner) {
		const marginX = parseInt(rawMarginXOrY) || 24;
		const marginY = parseInt(rawMarginYOrFontSize) || 24;

		// 更加激进的估算：每个字符约 32px，并增加 20px 的额外缓冲空间
		const estimatedTextWidth = (text.length * 32) + 20;

		if (rawPositionOrX === 'br') {
			x = baseWidth - marginX - estimatedTextWidth;
		} else {
			x = marginX;
		}
		y = baseHeight - marginY - 60; // 增加高度估算
	} else {
		// 绝对坐标模式
		x = parseInt(rawPositionOrX) || 0;
		y = parseInt(rawMarginXOrY) || 0;
	}

	// 最终安全检查：确保 x 坐标不会让文字尾部贴死边缘
	const minSafetyX = 10;
	const maxSafetyX = baseWidth - (text.length * 28); // 强制保底宽度
	x = Math.max(minSafetyX, Math.min(x, maxSafetyX));
	y = Math.max(10, Math.min(y, baseHeight - 50));

	try {
		console.log(`[Watermark] Image: ${baseWidth}x${baseHeight}, Text: "${text}", Final Pos: (${Math.round(x)}, ${Math.round(y)})`);
		// 使用 Photon 的原生绘制方法
		photon.draw_text(inputImage, text, Math.round(x), Math.round(y));
	} catch (e) {
		console.error('Photon draw_text failed:', e);
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
		const hasCache = await cache.match(cacheKey);

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
