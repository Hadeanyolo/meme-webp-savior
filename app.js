/* ===================================================
   WebP 魔法转换器 - 核心逻辑
   =================================================== */

(function () {
    'use strict';

    // ==================== State ====================
    const state = {
        files: [],          // { id, file, type:'static'|'animated', format:'png'|'jpg'|'gif', quality:90, status:'waiting'|'processing'|'done'|'error', frames:[] }
        dirHandle: null,    // File System Access directory handle
        isConverting: false,
        gifWorkerUrl: null, // Blob URL for gif.js worker
    };

    let fileIdCounter = 0;

    // ==================== Constants ====================
    const BG_COLORS = {
        transparent: {
            canvasFill: '#00ff00',   // Green chroma key
            gifTransparent: 0x00ff00 // Hex color number for gif.js
        },
        white: {
            canvasFill: '#ffffff',
            gifTransparent: null
        },
        black: {
            canvasFill: '#000000',
            gifTransparent: null
        }
    };

    // ==================== DOM Elements ====================
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const dom = {
        dropZone: $('#dropZone'),
        fileInput: $('#fileInput'),
        selectDirBtn: $('#selectDirBtn'),
        dirPath: $('#dirPath'),
        fileListSection: $('#fileListSection'),
        settingsBar: $('#settingsBar'),
        gifBgSelect: $('#gifBgSelect'),
        fileList: $('#fileList'),
        staticCount: $('#staticCount'),
        animatedCount: $('#animatedCount'),
        progressSection: $('#progressSection'),
        progressLabel: $('#progressLabel'),
        progressPercent: $('#progressPercent'),
        progressBar: $('#progressBar'),
        actionsBar: $('#actionsBar'),
        convertBtn: $('#convertBtn'),
        clearBtn: $('#clearBtn'),
        toastContainer: $('#toastContainer'),
        cardTemplate: $('#fileCardTemplate'),
    };

    // ==================== Initialization ====================
    function init() {
        checkApiSupport();
        initGifWorker();
        bindEvents();
    }

    function checkApiSupport() {
        if (!('showDirectoryPicker' in window)) {
            const warning = document.createElement('div');
            warning.className = 'api-warning';
            warning.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                <span>
                    请使用 <strong>Chrome / Edge</strong> 浏览器，并通过 <strong>localhost</strong> 访问本工具（双击 start.bat 即可）。
                    直接打开 HTML 文件不支持「选择文件夹保存」功能。
                </span>
            `;
            dom.dropZone.parentNode.insertBefore(warning, dom.dropZone.nextSibling);
        }
    }

    /** Pre-fetch gif.js worker script and create a blob URL to avoid cross-origin issues */
    async function initGifWorker() {
        try {
            const resp = await fetch('https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js');
            const text = await resp.text();
            const blob = new Blob([text], { type: 'application/javascript' });
            state.gifWorkerUrl = URL.createObjectURL(blob);
        } catch (e) {
            console.warn('Failed to load gif.js worker from CDN, GIF encoding may not work:', e);
        }
    }

    // ==================== Event Binding ====================
    function bindEvents() {
        // Drop zone
        dom.dropZone.addEventListener('click', () => dom.fileInput.click());
        dom.fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

        dom.dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dom.dropZone.classList.add('drag-over');
        });
        dom.dropZone.addEventListener('dragleave', () => {
            dom.dropZone.classList.remove('drag-over');
        });
        dom.dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dom.dropZone.classList.remove('drag-over');
            const files = [...e.dataTransfer.files].filter(f => f.name.toLowerCase().endsWith('.webp'));
            if (files.length === 0) {
                showToast('请拖入 .webp 格式的文件', 'warning');
                return;
            }
            handleFiles(files);
        });

        // Directory picker
        dom.selectDirBtn.addEventListener('click', selectOutputDir);

        // Actions
        dom.convertBtn.addEventListener('click', startConversion);
        dom.clearBtn.addEventListener('click', clearAll);
    }

    // ==================== File Handling ====================
    async function handleFiles(fileList) {
        const files = Array.from(fileList).filter(f => f.name.toLowerCase().endsWith('.webp'));
        if (files.length === 0) {
            showToast('未发现 WebP 文件', 'warning');
            return;
        }

        for (const file of files) {
            const buffer = await file.arrayBuffer();
            const type = detectWebPType(buffer);
            const defaultFormat = type === 'animated' ? 'gif' : 'png';

            const entry = {
                id: ++fileIdCounter,
                file,
                type,
                format: defaultFormat,
                quality: 90,
                status: 'waiting',
                animInfo: type === 'animated' ? parseAnimatedWebP(buffer) : null,
            };

            state.files.push(entry);
            addFileCard(entry);
        }

        updateStats();
        dom.fileListSection.style.display = '';
        dom.settingsBar.style.display = '';
        dom.actionsBar.style.display = '';

        // Reset file input so same files can be re-added
        dom.fileInput.value = '';
    }

    // ==================== WebP Binary Detection ====================

    /**
     * Detect if a WebP file is static or animated by parsing the RIFF header.
     * Looks for VP8X chunk with animation flag, or ANMF chunks.
     */
    function detectWebPType(buffer) {
        const view = new DataView(buffer);
        if (buffer.byteLength < 20) return 'static';

        // Verify RIFF header
        const riff = getString(view, 0, 4);
        const webp = getString(view, 8, 4);
        if (riff !== 'RIFF' || webp !== 'WEBP') return 'static';

        // Scan chunks
        let offset = 12;
        while (offset < buffer.byteLength - 8) {
            const chunkId = getString(view, offset, 4);
            const chunkSize = view.getUint32(offset + 4, true);

            if (chunkId === 'VP8X') {
                const flags = view.getUint8(offset + 8);
                const isAnimated = (flags & 0x02) !== 0; // bit 1 = animation flag
                if (isAnimated) return 'animated';
            }

            if (chunkId === 'ANMF') {
                return 'animated';
            }

            // Move to next chunk (chunks are padded to even size)
            offset += 8 + chunkSize + (chunkSize % 2);
        }

        return 'static';
    }

    /**
     * Parse animated WebP to extract frame info (offsets, durations, dimensions).
     */
    function parseAnimatedWebP(buffer) {
        const view = new DataView(buffer);
        const info = {
            canvasWidth: 0,
            canvasHeight: 0,
            loopCount: 0,
            bgColor: [0, 0, 0, 0],
            frames: [],
        };

        let offset = 12; // skip RIFF header

        while (offset < buffer.byteLength - 8) {
            const chunkId = getString(view, offset, 4);
            const chunkSize = view.getUint32(offset + 4, true);
            const dataOffset = offset + 8;

            if (chunkId === 'VP8X') {
                // Canvas dimensions (24-bit LE, +1)
                info.canvasWidth = (view.getUint16(dataOffset + 4, true) | (view.getUint8(dataOffset + 6) << 16)) + 1;
                info.canvasHeight = (view.getUint16(dataOffset + 7, true) | (view.getUint8(dataOffset + 9) << 16)) + 1;
            }

            if (chunkId === 'ANIM') {
                info.bgColor = [
                    view.getUint8(dataOffset),
                    view.getUint8(dataOffset + 1),
                    view.getUint8(dataOffset + 2),
                    view.getUint8(dataOffset + 3),
                ];
                info.loopCount = view.getUint16(dataOffset + 4, true);
            }

            if (chunkId === 'ANMF') {
                const frameX = (view.getUint16(dataOffset, true) | (view.getUint8(dataOffset + 2) << 16)) * 2;
                const frameY = (view.getUint16(dataOffset + 3, true) | (view.getUint8(dataOffset + 5) << 16)) * 2;
                const frameW = (view.getUint16(dataOffset + 6, true) | (view.getUint8(dataOffset + 8) << 16)) + 1;
                const frameH = (view.getUint16(dataOffset + 9, true) | (view.getUint8(dataOffset + 11) << 16)) + 1;
                const duration = view.getUint16(dataOffset + 12, true) | (view.getUint8(dataOffset + 14) << 16);
                const flags = view.getUint8(dataOffset + 15);
                const blending = (flags & 0x02) === 0; // 0 = alpha-blend, 1 = no blend
                const disposal = (flags & 0x01) !== 0;  // 0 = no dispose, 1 = dispose to bg

                // Frame bitstream starts at dataOffset + 16
                const frameDataOffset = dataOffset + 16;
                const frameDataSize = chunkSize - 16;
                const frameData = buffer.slice(frameDataOffset, frameDataOffset + frameDataSize);

                info.frames.push({
                    x: frameX,
                    y: frameY,
                    width: frameW,
                    height: frameH,
                    duration: Math.max(duration, 20), // minimum 20ms to avoid 0-duration frames
                    blending,
                    disposal,
                    data: frameData,
                });
            }

            offset += 8 + chunkSize + (chunkSize % 2);
        }

        return info;
    }



    // ==================== Conversion ====================

    async function startConversion() {
        const pending = state.files.filter(f => f.status === 'waiting' || f.status === 'error');
        if (pending.length === 0) {
            showToast('没有需要转换的文件', 'warning');
            return;
        }

        if (!state.dirHandle) {
            // If File System Access API is not supported, we'll fall back to download
            if (!('showDirectoryPicker' in window)) {
                showToast('将通过浏览器下载保存文件', 'warning');
            } else {
                showToast('请先选择保存位置', 'warning');
                return;
            }
        }

        state.isConverting = true;
        dom.convertBtn.disabled = true;
        dom.progressSection.style.display = '';

        let completed = 0;
        const total = pending.length;

        for (const entry of pending) {
            updateFileStatus(entry, 'processing');
            updateProgress(completed, total, `正在转换: ${entry.file.name}`);

            try {
                let blob;
                if (entry.type === 'animated' && entry.format === 'gif') {
                    blob = await convertAnimatedToGif(entry);
                } else {
                    blob = await convertStatic(entry);
                }

                const outputName = getOutputFilename(entry.file.name, entry.format);
                await saveFile(outputName, blob);

                entry.status = 'done';
                updateFileStatus(entry, 'done');
            } catch (err) {
                console.error('Conversion failed:', entry.file.name, err);
                entry.status = 'error';
                updateFileStatus(entry, 'error');
                showToast(`转换失败: ${entry.file.name}`, 'error');
            }

            completed++;
            updateProgress(completed, total, completed === total ? '转换完成！' : `正在转换...`);
        }

        state.isConverting = false;
        dom.convertBtn.disabled = false;

        const successCount = pending.filter(f => f.status === 'done').length;
        if (successCount > 0) {
            showToast(`✅ 成功转换 ${successCount} 个文件`, 'success');
        }
    }

    /**
     * Convert a static WebP (or animated WebP to static format) using Canvas API.
     */
    function convertStatic(entry) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(entry.file);

            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');

                // For JPG, fill white background (no transparency support)
                if (entry.format === 'jpg') {
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                }

                ctx.drawImage(img, 0, 0);
                URL.revokeObjectURL(url);

                const mimeType = entry.format === 'jpg' ? 'image/jpeg' : 'image/png';
                const quality = entry.format === 'jpg' ? entry.quality / 100 : undefined;

                canvas.toBlob(
                    (blob) => {
                        if (blob) resolve(blob);
                        else reject(new Error('Canvas toBlob failed'));
                    },
                    mimeType,
                    quality
                );
            };

            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Failed to load image'));
            };

            img.src = url;
        });
    }

    /**
     * Convert an animated WebP to GIF.
     * Uses ImageDecoder API (Chrome 94+) for reliable frame-by-frame extraction,
     * with a canvas-snapshot fallback for older browsers.
     */
    async function convertAnimatedToGif(entry) {
        // Primary: ImageDecoder API (reliable, browser-native decoding)
        if ('ImageDecoder' in window) {
            try {
                return await convertAnimatedViaImageDecoder(entry);
            } catch (e) {
                console.warn('ImageDecoder approach failed, trying fallback:', e);
            }
        }

        // Fallback: snapshot the first frame as a static GIF
        console.warn('ImageDecoder not available, converting as single-frame GIF');
        return convertStatic({ ...entry, format: 'png' });
    }

    /**
     * Scan image pixels to find if the image has transparency, and if so,
     * find a chroma key color that is furthest from any color present in the image.
     * This prevents parts of the image that match the chroma key color from becoming transparent (e.g. green grass).
     */
    function findBestChromaKey(imgData) {
        // First, check if there are any transparent pixels at all
        let hasTransparency = false;
        for (let i = 0; i < imgData.length; i += 4) {
            if (imgData[i+3] < 128) { // standard 50% alpha threshold for checking transparency presence
                hasTransparency = true;
                break;
            }
        }

        if (!hasTransparency) {
            return { hasTransparency: false, bgConfig: null };
        }

        const candidates = [
            { name: 'magenta', r: 255, g: 0, b: 255, canvasFill: '#ff00ff', gifTransparent: 0xff00ff },
            { name: 'green', r: 0, g: 255, b: 0, canvasFill: '#00ff00', gifTransparent: 0x00ff00 },
            { name: 'cyan', r: 0, g: 255, b: 255, canvasFill: '#00ffff', gifTransparent: 0x00ffff },
            { name: 'yellow', r: 255, g: 255, b: 0, canvasFill: '#ffff00', gifTransparent: 0xffff00 },
            { name: 'blue', r: 0, g: 0, b: 255, canvasFill: '#0000ff', gifTransparent: 0x0000ff },
            { name: 'red', r: 255, g: 0, b: 0, canvasFill: '#ff0000', gifTransparent: 0xff0000 }
        ];

        const minDists = candidates.map(() => Infinity);

        for (let i = 0; i < imgData.length; i += 4) {
            const r = imgData[i];
            const g = imgData[i+1];
            const b = imgData[i+2];
            const a = imgData[i+3];

            // Only consider opaque or mostly opaque pixels
            if (a < 30) continue;

            for (let j = 0; j < candidates.length; j++) {
                const c = candidates[j];
                const distSq = (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2;
                if (distSq < minDists[j]) {
                    minDists[j] = distSq;
                }
            }
        }

        // Find the candidate with the maximum minimum distance
        let maxIdx = 0;
        for (let j = 1; j < minDists.length; j++) {
            if (minDists[j] > minDists[maxIdx]) {
                maxIdx = j;
            }
        }

        return { hasTransparency: true, bgConfig: candidates[maxIdx] };
    }

    /**
     * Use the browser's native ImageDecoder API to decode animated WebP
     * frame-by-frame, then re-encode as GIF via gif.js.
     */
    async function convertAnimatedViaImageDecoder(entry) {
        const url = URL.createObjectURL(entry.file);

        try {
            const response = await fetch(url);
            const decoder = new ImageDecoder({
                type: 'image/webp',
                data: response.body,
            });

            await decoder.completed;

            const track = decoder.tracks.selectedTrack;
            const frameCount = track.frameCount;

            if (frameCount === 0) {
                decoder.close();
                throw new Error('No frames found in animated WebP');
            }

            // Decode first frame to get canvas dimensions and analyze colors
            const firstResult = await decoder.decode({ frameIndex: 0 });
            const width = firstResult.image.displayWidth;
            const height = firstResult.image.displayHeight;
            const firstVideoFrame = firstResult.image;

            // Set up canvas for frame capture and color analysis
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            // Set willReadFrequently to true to fix console warning
            const ctx = canvas.getContext('2d', { willReadFrequently: true });

            // Draw first frame to analyze pixels
            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(firstVideoFrame, 0, 0);
            const firstFrameData = ctx.getImageData(0, 0, width, height).data;
            firstVideoFrame.close();

            // Get background configuration
            const bgMode = dom.gifBgSelect ? dom.gifBgSelect.value : 'transparent';
            let bgConfig;
            let hasTransparency = false;

            if (bgMode === 'transparent') {
                const analysis = findBestChromaKey(firstFrameData);
                hasTransparency = analysis.hasTransparency;
                bgConfig = analysis.bgConfig;
            } else {
                hasTransparency = true; // For solid color mode, we fill the background
                bgConfig = BG_COLORS[bgMode] || BG_COLORS.transparent;
            }

            if (!state.gifWorkerUrl) {
                decoder.close();
                throw new Error('GIF worker not loaded — check network connection');
            }

            const gif = new GIF({
                workers: 2,
                quality: 2, // 提高采样质量（从10提升到2），大幅减少颜色量化误差引起的噪点与透明“破洞”
                width,
                height,
                workerScript: state.gifWorkerUrl,
                transparent: hasTransparency ? bgConfig.gifTransparent : null, // 如果原图是不透明的，不设置透明色，防止发生颜色误杀
            });

            // Decode every frame and add to GIF
            for (let i = 0; i < frameCount; i++) {
                const result = await decoder.decode({ frameIndex: i });
                const videoFrame = result.image;

                ctx.clearRect(0, 0, width, height);
                ctx.drawImage(videoFrame, 0, 0);

                // For transparent mode (and only if the original image has transparent pixels),
                // threshold the alpha channel to force binary transparency.
                // This prevents semi-transparent pixels (like shadows or anti-aliasing edges) from blending
                // with the chroma key color and being misclassified as the transparent background color.
                if (bgMode === 'transparent' && hasTransparency) {
                    const imgData = ctx.getImageData(0, 0, width, height);
                    const data = imgData.data;
                    const threshold = 128; // Standard 50% alpha threshold
                    for (let j = 0; j < data.length; j += 4) {
                        const alpha = data[j + 3];
                        if (alpha < threshold) {
                            data[j + 3] = 0;
                        } else {
                            data[j + 3] = 255;
                        }
                    }
                    ctx.putImageData(imgData, 0, 0);

                    // Draw the chroma key background behind the thresholded image
                    if (bgConfig && bgConfig.canvasFill) {
                        ctx.globalCompositeOperation = 'destination-over';
                        ctx.fillStyle = bgConfig.canvasFill;
                        ctx.fillRect(0, 0, width, height);
                        ctx.globalCompositeOperation = 'source-over'; // restore default
                    }
                } else if (bgMode !== 'transparent') {
                    // For solid color modes (white/black), draw the background color behind the image
                    if (bgConfig && bgConfig.canvasFill) {
                        ctx.globalCompositeOperation = 'destination-over';
                        ctx.fillStyle = bgConfig.canvasFill;
                        ctx.fillRect(0, 0, width, height);
                        ctx.globalCompositeOperation = 'source-over';
                    }
                }

                // VideoFrame.duration is in microseconds; convert to ms
                const durationMs = videoFrame.duration
                    ? videoFrame.duration / 1000
                    : (entry.animInfo?.frames?.[i]?.duration || 100);

                gif.addFrame(ctx, {
                    copy: true,
                    delay: Math.max(Math.round(durationMs), 20),
                    dispose: 2, // 设置帧处理动作为清除到背景（避免透明背景叠影和像素溢出产生黑点）
                });

                videoFrame.close();
            }

            decoder.close();

            // Render and return the GIF blob
            return new Promise((resolve, reject) => {
                gif.on('finished', (blob) => resolve(blob));
                gif.on('error', (err) => reject(err));
                gif.render();
            });

        } finally {
            URL.revokeObjectURL(url);
        }
    }

    // ==================== File Saving ====================

    async function selectOutputDir() {
        if (!('showDirectoryPicker' in window)) {
            showToast('当前浏览器不支持选择文件夹，请使用 Chrome/Edge 并通过 localhost 访问', 'error');
            return;
        }

        try {
            state.dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
            dom.dirPath.textContent = state.dirHandle.name;
            dom.dirPath.classList.add('selected');
            showToast(`已选择保存位置: ${state.dirHandle.name}`, 'success');
        } catch (e) {
            if (e.name !== 'AbortError') {
                showToast('选择文件夹失败', 'error');
            }
        }
    }

    async function saveFile(filename, blob) {
        if (state.dirHandle) {
            // Use File System Access API
            const handle = await state.dirHandle.getFileHandle(filename, { create: true });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
        } else {
            // Fallback: browser download
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
    }

    // ==================== UI Updates ====================

    function addFileCard(entry) {
        const template = dom.cardTemplate.content.cloneNode(true);
        const card = template.querySelector('.file-card');
        card.dataset.id = entry.id;
        card.style.animationDelay = `${(state.files.indexOf(entry) % 10) * 0.04}s`;

        // Preview
        const previewImg = card.querySelector('.preview-img');
        previewImg.src = URL.createObjectURL(entry.file);

        // Type badge
        const typeBadge = card.querySelector('.type-badge');
        typeBadge.textContent = entry.type === 'animated' ? '动态' : '静态';
        typeBadge.classList.add(entry.type === 'animated' ? 'animated' : 'static');

        // File info
        card.querySelector('.file-name').textContent = entry.file.name;
        card.querySelector('.file-size').textContent = formatFileSize(entry.file.size);

        // Format select
        const formatSelect = card.querySelector('.format-select');
        formatSelect.value = entry.format;
        const qualitySlider = card.querySelector('.quality-slider');
        const slider = card.querySelector('.slider');
        const qualityValue = card.querySelector('.quality-value');

        if (entry.format === 'jpg') {
            qualitySlider.style.display = '';
        }

        formatSelect.addEventListener('change', () => {
            entry.format = formatSelect.value;
            qualitySlider.style.display = formatSelect.value === 'jpg' ? '' : 'none';
        });

        slider.addEventListener('input', () => {
            entry.quality = parseInt(slider.value);
            qualityValue.textContent = slider.value + '%';
        });

        dom.fileList.appendChild(card);
    }

    function updateFileStatus(entry, status) {
        const card = dom.fileList.querySelector(`.file-card[data-id="${entry.id}"]`);
        if (!card) return;

        // Hide all status icons
        card.querySelectorAll('.status-icon').forEach(el => el.style.display = 'none');

        // Show the active one
        const iconMap = {
            waiting: '.status-waiting',
            processing: '.status-processing',
            done: '.status-done',
            error: '.status-error',
        };

        const icon = card.querySelector(iconMap[status]);
        if (icon) icon.style.display = '';

        // Update card class
        card.classList.remove('done', 'error');
        if (status === 'done') card.classList.add('done');
        if (status === 'error') card.classList.add('error');
    }

    function updateProgress(current, total, label) {
        const pct = total > 0 ? Math.round((current / total) * 100) : 0;
        dom.progressBar.style.width = pct + '%';
        dom.progressPercent.textContent = pct + '%';
        dom.progressLabel.textContent = label || `${current} / ${total}`;
    }

    function updateStats() {
        const staticFiles = state.files.filter(f => f.type === 'static').length;
        const animatedFiles = state.files.filter(f => f.type === 'animated').length;

        dom.staticCount.style.display = staticFiles > 0 ? '' : 'none';
        dom.staticCount.querySelector('strong').textContent = staticFiles;

        dom.animatedCount.style.display = animatedFiles > 0 ? '' : 'none';
        dom.animatedCount.querySelector('strong').textContent = animatedFiles;
    }

    function clearAll() {
        state.files = [];
        dom.fileList.innerHTML = '';
        dom.fileListSection.style.display = 'none';
        dom.settingsBar.style.display = 'none';
        dom.actionsBar.style.display = 'none';
        dom.progressSection.style.display = 'none';
        dom.progressBar.style.width = '0%';
        dom.progressPercent.textContent = '0%';
        updateStats();
        showToast('已清空所有文件', 'success');
    }

    // ==================== Toast ====================
    function showToast(message, type = 'info') {
        const iconMap = {
            success: '✅',
            error: '❌',
            warning: '⚠️',
            info: 'ℹ️',
        };

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <span class="toast-icon">${iconMap[type]}</span>
            <span>${message}</span>
        `;

        dom.toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'toastOut 0.3s ease-out forwards';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ==================== Utilities ====================
    function getString(view, offset, length) {
        let result = '';
        for (let i = 0; i < length; i++) {
            result += String.fromCharCode(view.getUint8(offset + i));
        }
        return result;
    }



    function getOutputFilename(originalName, format) {
        const base = originalName.replace(/\.webp$/i, '');
        const ext = format === 'jpg' ? 'jpg' : format;
        return `${base}.${ext}`;
    }

    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // ==================== Start ====================
    document.addEventListener('DOMContentLoaded', init);
})();
