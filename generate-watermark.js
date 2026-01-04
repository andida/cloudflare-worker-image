const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

/**
 * 配置项
 */
const TEXT = 'ImgEdify.ai';
const FONT_SIZE = 60;
const PADDING_H = 40; // 水平内边距
const PADDING_V = 20; // 垂直内边距
const BG_OPACITY = 0.4; // 背景透明度 (0-1)
const OUTPUT_FILE = 'watermark.png';

async function generate() {
    try {
        // 1. 预估文本宽度（粗略计算，稍后根据实际测量调整）
        // 在没有加载特定字体时，默认使用 sans-serif
        const tempCanvas = createCanvas(100, 100);
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.font = `bold ${FONT_SIZE}px sans-serif`;
        const metrics = tempCtx.measureText(TEXT);

        const textWidth = metrics.width;
        const textHeight = FONT_SIZE * 0.8; // 估算高度

        const canvasWidth = textWidth + PADDING_H * 2;
        const canvasHeight = FONT_SIZE + PADDING_V * 2;

        // 2. 创建正式画布
        const canvas = createCanvas(canvasWidth, canvasHeight);
        const ctx = canvas.getContext('2d');

        // 3. 绘制半透明圆角背板 (Pill Shape)
        ctx.fillStyle = `rgba(0, 0, 0, ${BG_OPACITY})`;
        const radius = canvasHeight / 2;

        ctx.beginPath();
        ctx.moveTo(radius, 0);
        ctx.lineTo(canvasWidth - radius, 0);
        ctx.quadraticCurveTo(canvasWidth, 0, canvasWidth, radius);
        ctx.lineTo(canvasWidth, canvasHeight - radius);
        ctx.quadraticCurveTo(canvasWidth, canvasHeight, canvasWidth - radius, canvasHeight);
        ctx.lineTo(radius, canvasHeight);
        ctx.quadraticCurveTo(0, canvasHeight, 0, canvasHeight - radius);
        ctx.lineTo(0, radius);
        ctx.quadraticCurveTo(0, 0, radius, 0);
        ctx.closePath();
        ctx.fill();

        // 4. 绘制文字
        ctx.font = `bold ${FONT_SIZE}px sans-serif`;
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // 增加极细的边缘阴影以增强在纯白底上的辨识度
        ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;

        ctx.fillText(TEXT, canvasWidth / 2, canvasHeight / 2 + 2);

        // 5. 保存文件
        const buffer = canvas.toBuffer('image/png');
        fs.writeFileSync(path.join(process.cwd(), OUTPUT_FILE), buffer);

        console.log(`✅ 成功生成水印图片: ${OUTPUT_FILE}`);
        console.log(`📏 尺寸: ${canvasWidth}x${canvasHeight}`);
    } catch (err) {
        console.error('❌ 生成失败:', err);
    }
}

generate();
