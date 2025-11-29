// CONFIGURATION
const BUFFER_THRESHOLD = 1024 * 1024; // 1 MB Buffer

/**
 * 🛠 AIFF PARSER (The Core Engine)
 * Parses raw bytes, extracts metadata, and converts Big-Endian PCM to Float32.
 */
class AiffParser {
    constructor() {
        this.headerParsed = false;
        this.numChannels = 2;
        this.sampleRate = 44100;
        this.bitDepth = 16;
        this.dataOffset = 0; // Where SSND data starts
        this.dataSize = 0;
        this.frameSize = 4; // channels * bytesPerSample
    }

    // Helper: Convert AIFF 80-bit Extended Float to Javascript Double
    parseExtended(view, offset) {
        const exponent = view.getUint16(offset, false);
        let mantissaHigh = view.getUint32(offset + 2, false);
        let mantissaLow = view.getUint32(offset + 6, false);
        
        const sign = (exponent & 0x8000) ? -1 : 1;
        const exp = (exponent & 0x7FFF) - 16383;
        
        let mantissa = mantissaHigh * Math.pow(2, -32) + mantissaLow * Math.pow(2, -64);
        
        if (exp === -16383) return 0; // Denormalized or zero
        
        // 80-bit float has an explicit integer bit (unlike 64-bit IEEE)
        // If the integer bit is set (normal number), we normalize.
        // Usually AIFF 80-bit floats are normalized.
        
        return sign * mantissa * Math.pow(2, exp);
    }

    parseHeader(view) {
        if (this.headerParsed) return true;
        
        // Check "FORM"
        const formId = this.getAscii(view, 0, 4);
        if (formId !== 'FORM') return false; // Not enough data or invalid
        
        // Check "AIFF"
        const typeId = this.getAscii(view, 8, 4);
        if (typeId !== 'AIFF') return false;

        let offset = 12;
        let foundComm = false;
        let foundSsnd = false;

        // Scan chunks
        while (offset < view.byteLength) {
            if (offset + 8 > view.byteLength) break; // Incomplete chunk header

            const chunkId = this.getAscii(view, offset, 4);
            const chunkSize = view.getUint32(offset + 4, false); // Big Endian size

            if (chunkId === 'COMM') {
                if (offset + 26 > view.byteLength) break; // Need enough bytes for COMM
                
                this.numChannels = view.getInt16(offset + 8, false);
                // numSampleFrames (4 bytes) at offset+10
                this.bitDepth = view.getInt16(offset + 14, false);
                // sampleRate (10 bytes) at offset+16
                this.sampleRate = this.parseExtended(view, offset + 16);
                
                foundComm = true;
                // console.log(`AIFF Metadata: ${this.numChannels}ch, ${this.sampleRate}Hz, ${this.bitDepth}bit`);
            }
            else if (chunkId === 'SSND') {
                // SSND chunk data starts at offset + 8 (header) + 8 (offset/blockSize)
                // The actual audio data starts after the chunk header + 8 bytes of SSND parameters
                this.dataOffset = offset + 8 + 8; 
                this.dataSize = chunkSize - 8;
                foundSsnd = true;
            }

            offset += 8 + chunkSize;
            // Pad byte if size is odd
            if (chunkSize % 2 !== 0) offset++;
            
            if (foundComm && foundSsnd) {
                this.headerParsed = true;
                this.frameSize = this.numChannels * (this.bitDepth / 8);
                return true;
            }
        }
        return false;
    }

    // Convert raw Big-Endian bytes to Float32 Planes (WebAudio format)
    decode(rawBytes) {
        // rawBytes is a Uint8Array containing ONLY the audio data part
        const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
        const numSamples = Math.floor(rawBytes.byteLength / (this.bitDepth / 8));
        const numFrames = Math.floor(numSamples / this.numChannels);

        // Prepare output planes (Planar format: LLL... RRR...)
        const planes = [];
        for (let ch = 0; ch < this.numChannels; ch++) {
            planes.push(new Float32Array(numFrames));
        }

        let bytePtr = 0;
        const is16Bit = this.bitDepth === 16;
        const is24Bit = this.bitDepth === 24;

        for (let i = 0; i < numFrames; i++) {
            for (let ch = 0; ch < this.numChannels; ch++) {
                let sample = 0;
                
                if (is16Bit) {
                    // Big Endian 16-bit
                    sample = view.getInt16(bytePtr, false);
                    sample = sample / 32768.0; // Normalize to -1.0 -> 1.0
                    bytePtr += 2;
                } else if (is24Bit) {
                    // Big Endian 24-bit
                    const b1 = view.getUint8(bytePtr);
                    const b2 = view.getUint8(bytePtr + 1);
                    const b3 = view.getUint8(bytePtr + 2);
                    // Combine to 24-bit signed
                    let s32 = (b1 << 24) | (b2 << 16) | (b3 << 8);
                    s32 = s32 >> 8; // Sign extend
                    sample = s32 / 8388608.0;
                    bytePtr += 3;
                } else {
                    // 8-bit (Usually signed in AIFF)
                    sample = view.getInt8(bytePtr);
                    sample = sample / 128.0;
                    bytePtr += 1;
                }

                planes[ch][i] = sample;
            }
        }
        return planes;
    }

    getAscii(view, offset, len) {
        let str = "";
        for (let i = 0; i < len; i++) {
            const charCode = view.getUint8(offset + i);
            if (charCode > 31 && charCode < 127) str += String.fromCharCode(charCode);
        }
        return str;
    }
}

/**
 * 🎨 VISUALIZER
 */
class Visualizer {
    constructor(canvasId, onSeek) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext("2d");
        this.onSeek = onSeek;
        this.analyser = null;
        this.dataArray = null;
        this.animationId = null;
        this.totalDuration = 0; 
        this.elCurrent = document.getElementById("v-current-time");
        this.elTotal = document.getElementById("v-total-time");
        
        this.resize();
        window.addEventListener("resize", () => this.resize());
        this.canvas.addEventListener("click", (e) => this.handleClick(e));
    }

    resize() {
        if (!this.canvas) return;
        this.canvas.width = this.canvas.clientWidth * window.devicePixelRatio;
        this.canvas.height = 51 * window.devicePixelRatio;
        this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    }

    handleClick(e) {
        if (this.totalDuration <= 0) return;
        const rect = this.canvas.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        this.onSeek(pct * this.totalDuration);
    }

    connect(analyser) {
        this.analyser = analyser;
        this.analyser.fftSize = 128; 
        this.analyser.smoothingTimeConstant = 0.8;
        this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
        this.startLoop();
    }

    updateTime(cur, total) {
        this.totalDuration = total;
        const fmt = t => Math.floor(t/60) + ":" + Math.floor(t%60).toString().padStart(2,'0');
        if(this.elCurrent) this.elCurrent.textContent = fmt(cur);
        if(this.elTotal) this.elTotal.textContent = fmt(total);
    }

    startLoop() {
        if (this.animationId) cancelAnimationFrame(this.animationId);
        const draw = () => {
            this.drawFrame();
            this.animationId = requestAnimationFrame(draw);
        };
        draw();
    }

    drawFrame() {
        if (!this.ctx || !this.analyser) return;
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        this.analyser.getByteFrequencyData(this.dataArray);
        
        this.ctx.fillStyle = "#000000";
        this.ctx.fillRect(0, 0, w, h);

        const progressX = this.totalDuration > 0 ? (this.currentTime / this.totalDuration) * w : 0;
        const barWidth = 2; const gap = 1;
        const totalBars = Math.floor(w / (barWidth + gap));
        const step = Math.floor(this.dataArray.length / totalBars);

        let x = 0;
        for (let i = 0; i < totalBars; i++) {
            const dataIndex = Math.min(i * step, this.dataArray.length - 1);
            const value = this.dataArray[dataIndex];
            const percent = value / 255;
            const barHeight = Math.max(2, h * percent * 0.9); 
            const y = (h - barHeight) / 2; 

            this.ctx.fillStyle = (x < progressX) ? "#FFD700" : "#3d3414";
            this.ctx.fillRect(x, y, 1, barHeight); 
            x += (barWidth + gap);
        }
        
        if (this.totalDuration > 0) {
            this.ctx.fillStyle = "#FFF";
            this.ctx.fillRect(progressX, 0, 1, h);
        }
    }
    
    stop() {
        if (this.animationId) cancelAnimationFrame(this.animationId);
        if (this.ctx) {
            this.ctx.fillStyle = "#000000";
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }
        if(this.elCurrent) this.elCurrent.textContent = "0:00";
        if(this.elTotal) this.elTotal.textContent = "--:--";
    }
}

/**
 * 🔈 BASE PLAYER
 */
class BasePlayer {
    constructor() {
        this.audioCtx = null;
        this.analyser = null;
        this.activeSource = null;
        this.abortController = null;
        this.fullAudioBuffer = null;
        this.visualizer = null;
        this.isStopped = true;
        this.isDownloading = false;
        this.startTime = 0;
        this.playedOffset = 0;
        this.monitorId = null;
    }

    init(visualizer) {
        this.visualizer = visualizer;
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.connect(this.audioCtx.destination);
            visualizer.connect(this.analyser);
        }
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
        this.startMonitor();
    }

    startMonitor() {
        if (this.monitorId) clearInterval(this.monitorId);
        this.monitorId = setInterval(() => {
            if (this.isStopped) return;
            if (this.activeSource && this.audioCtx) {
                const now = this.audioCtx.currentTime;
                let cur = this.playedOffset + (now - this.startTime);
                if (this.fullAudioBuffer && cur > this.fullAudioBuffer.duration) cur = this.fullAudioBuffer.duration;
                this.visualizer.currentTime = cur;
                // If downloading, use estimated total; else use real buffer duration
                const total = this.isDownloading && this.estimatedDuration ? this.estimatedDuration : (this.fullAudioBuffer ? this.fullAudioBuffer.duration : 0);
                this.visualizer.updateTime(cur, total);
            }
            // Auto-Revive
            if (this.fullAudioBuffer && !this.activeSource) {
                const tol = 0.2;
                if (this.playedOffset < this.fullAudioBuffer.duration - tol) {
                    // console.log("Reviving...");
                    this.playSourceFrom(this.playedOffset);
                }
            }
        }, 100);
    }

    stop() {
        this.isStopped = true;
        this.isDownloading = false;
        if (this.monitorId) clearInterval(this.monitorId);
        if (this.abortController) { this.abortController.abort(); this.abortController = null; }
        if (this.activeSource) { this.activeSource.onended = null; try { this.activeSource.stop(); } catch(e){} this.activeSource = null; }
        if (this.audioCtx) { this.audioCtx.close().catch(()=>{}); this.audioCtx = null; }
        this.fullAudioBuffer = null;
        this.playedOffset = 0;
    }

    playSourceFrom(time) {
        if (this.isStopped || !this.fullAudioBuffer || !this.audioCtx) return;
        if (this.activeSource) { this.activeSource.onended = null; try { this.activeSource.stop(); } catch(e){} }

        const source = this.audioCtx.createBufferSource();
        source.buffer = this.fullAudioBuffer;
        source.connect(this.analyser);
        this.activeSource = source;
        this.startTime = this.audioCtx.currentTime;
        this.playedOffset = time;
        source.start(0, time);
        source.onended = () => {
            if (this.isStopped) return;
            const playedDuration = this.audioCtx.currentTime - this.startTime;
            this.playedOffset = this.playedOffset + playedDuration;
            this.activeSource = null;
        };
    }

    seek(time) {
        if (this.isStopped || !this.fullAudioBuffer) return;
        time = Math.max(0, Math.min(time, this.fullAudioBuffer.duration - 0.1));
        this.playSourceFrom(time);
    }
}

/**
 * 🌊 AIFF MANUAL PLAYER
 */
class AiffManualPlayer extends BasePlayer {
    constructor() {
        super();
        this.parser = new AiffParser();
        this.pcmPlanes = []; // Array of Float32Arrays for each channel
        this.totalSamplesProcessed = 0;
        this.estimatedDuration = 0;
        this.totalFileBytes = 0;
    }

    async play(url, onProgress) {
        this.isStopped = false;
        this.isDownloading = true;
        this.init(visualizer);
        this.abortController = new AbortController();

        try {
            const response = await fetch(url, { signal: this.abortController.signal });
            this.totalFileBytes = +response.headers.get('Content-Length');
            const reader = response.body.getReader();
            
            // Accumulate all bytes in a growing array for this manual parser approach
            // Note: For huge files (100MB+), this is memory heavy. But reliable for AIFF.
            let receivedChunks = [];
            let totalReceivedLength = 0;
            let lastDecodeOffset = 0; // Where we stopped processing audio data

            while (true) {
                const { done, value } = await reader.read();
                if (this.isStopped) return;
                if (done) {
                    this.isDownloading = false;
                    await this.process(receivedChunks, totalReceivedLength, true);
                    break;
                }

                receivedChunks.push(value);
                totalReceivedLength += value.length;

                onProgress((totalReceivedLength/this.totalFileBytes)*100, (totalReceivedLength/1024/1024).toFixed(2) + " MB", "Parsing AIFF...");

                // Every 1MB, try to parse
                if (totalReceivedLength - lastDecodeOffset >= BUFFER_THRESHOLD) {
                    // We just pass everything. The parser will handle the state.
                    // (Optimization: In production, we would slice only new data, but header parsing requires context)
                    // For Simplicity & Reliability: We rebuild from the accumulated chunks.
                    await this.process(receivedChunks, totalReceivedLength, false);
                    lastDecodeOffset = totalReceivedLength;
                }
            }
            onProgress(100, "Done", "Playing");
        } catch (e) { if (e.name !== "AbortError") console.error(e); }
    }

    async process(chunks, size, isFinal) {
        if (this.isStopped) return;

        // Flatten chunks for parsing
        const flat = new Uint8Array(size);
        let off = 0; for (let c of chunks) { flat.set(c, off); off += c.length; }
        const view = new DataView(flat.buffer);

        // 1. Parse Header
        if (!this.parser.headerParsed) {
            const success = this.parser.parseHeader(view);
            if (!success) return; // Wait for more data
        }

        // 2. Decode Available Audio Data
        // Calculate where audio data ends
        const dataEnd = Math.min(flat.byteLength, this.parser.dataOffset + this.parser.dataSize);
        // Only decode if we have data past the offset
        if (flat.byteLength > this.parser.dataOffset) {
            // Get the raw audio part
            const audioRaw = new Uint8Array(flat.buffer, this.parser.dataOffset, dataEnd - this.parser.dataOffset);
            
            // Convert to Float32
            const pcmData = this.parser.decode(audioRaw);
            
            // Create AudioBuffer
            const length = pcmData[0].length;
            if (length > 0) {
                const buffer = this.audioCtx.createBuffer(this.parser.numChannels, length, this.parser.sampleRate);
                for (let ch = 0; ch < this.parser.numChannels; ch++) {
                    buffer.copyToChannel(pcmData[ch], ch);
                }
                this.fullAudioBuffer = buffer;
                
                // Update Estimate
                this.estimatedDuration = (this.totalFileBytes / (this.parser.bitDepth/8 * this.parser.numChannels)) / this.parser.sampleRate;
            }
        }
    }
}

/**
 * 🌊 GENERIC PLAYER (MP3/WAV/FLAC)
 * Uses the previous robust logic (StreamPlayer)
 */
class GenericPlayer extends BasePlayer {
    constructor(type) {
        super();
        this.type = type;
        this.INITIAL_THRESHOLD = (type === "WAV") ? 1024 * 1024 : 256 * 1024;
    }

    async play(url, onProgress) {
        this.isStopped = false;
        this.isDownloading = true;
        this.init(visualizer);
        this.abortController = new AbortController();

        try {
            const response = await fetch(url, { signal: this.abortController.signal });
            this.totalFileBytes = +response.headers.get('Content-Length');
            const reader = response.body.getReader();
            let chunks = []; let totalBytes = 0; let lastProcessedBytes = 0; let isFirst = true;

            while (true) {
                const { done, value } = await reader.read();
                if (this.isStopped) return;
                if (done) {
                    this.isDownloading = false;
                    if (totalBytes > lastProcessedBytes) await this.process(chunks, totalBytes, true);
                    break;
                }
                chunks.push(value); totalBytes += value.length;
                onProgress((totalBytes/this.totalFileBytes)*100, (totalBytes/1024/1024).toFixed(2) + " MB", `Buffering ${this.type}...`);
                const threshold = isFirst ? this.INITIAL_THRESHOLD : BUFFER_THRESHOLD;
                if (totalBytes - lastProcessedBytes >= threshold) {
                    await this.process(chunks, totalBytes, false);
                    lastProcessedBytes = totalBytes;
                    isFirst = false;
                }
            }
            onProgress(100, "Done", "Playing");
        } catch (e) { if (e.name !== "AbortError") console.error(e); }
    }

    async process(chunks, size, isFinal) {
        if (this.isStopped) return;
        const flat = new Uint8Array(size);
        let off = 0; for (let c of chunks) { flat.set(c, off); off += c.length; }
        
        // Use Header Patching only for WAV now (AIFF has its own player)
        if (this.type === "WAV" && !isFinal) WavHeaderPatcher.patch(new DataView(flat.buffer), size);

        try {
            const decoded = await this.audioCtx.decodeAudioData(flat.buffer.slice(0));
            this.fullAudioBuffer = decoded;
            if (this.totalFileBytes > 0 && size > 0) this.estimatedDuration = decoded.duration * (this.totalFileBytes / size);
        } catch (e) {}
    }
}

/**
 * 🏭 FACTORY
 */
class PlayerFactory {
    static getPlayer(type) {
        if (type === "AIFF") return new AiffManualPlayer();
        return new GenericPlayer(type);
    }
}

// [DATA & UI SETUP REMAINS THE SAME]
const PLAYLIST = [
    { type: "AIFF", url: "https://pdkkheetcdvnrsikdses.supabase.co/storage/v1/object/sign/user-files/ea12cfd6-0a51-42f4-9ad6-ba33fff1846f/sample4.aiff?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV84MTRmNzI0Yi1lYzI2LTQ4ZmUtYjk4ZS04Mjk1ZmYxYzBmMGMiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ1c2VyLWZpbGVzL2VhMTJjZmQ2LTBhNTEtNDJmNC05YWQ2LWJhMzNmZmYxODQ2Zi9zYW1wbGU0LmFpZmYiLCJpYXQiOjE3NjQ0MjY4OTUsImV4cCI6MTc2NDUxMzI5NX0.umFufQ8e-jgCtLXJbA4qDpVDeBZd6zNGU4OBXKsZ8J0" },
    { type: "FLAC", url: "https://pdkkheetcdvnrsikdses.supabase.co/storage/v1/object/sign/user-files/ea12cfd6-0a51-42f4-9ad6-ba33fff1846f/sample3.flac?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV84MTRmNzI0Yi1lYzI2LTQ4ZmUtYjk4ZS04Mjk1ZmYxYzBmMGMiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ1c2VyLWZpbGVzL2VhMTJjZmQ2LTBhNTEtNDJmNC05YWQ2LWJhMzNmZmYxODQ2Zi9zYW1wbGUzLmZsYWMiLCJpYXQiOjE3NjQ0MjcwOTUsImV4cCI6MTc2NDUxMzQ5NX0.c6qaIX5TpLJIGQJ3HfLIH7e3brnC39lEUVpjYPbXqME" },
    { type: "WAV", url: "https://pdkkheetcdvnrsikdses.supabase.co/storage/v1/object/sign/user-files/ea12cfd6-0a51-42f4-9ad6-ba33fff1846f/sample4.wav?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV84MTRmNzI0Yi1lYzI2LTQ4ZmUtYjk4ZS04Mjk1ZmYxYzBmMGMiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ1c2VyLWZpbGVzL2VhMTJjZmQ2LTBhNTEtNDJmNC05YWQ2LWJhMzNmZmYxODQ2Zi9zYW1wbGU0LndhdiIsImlhdCI6MTc2NDQyNzEwMywiZXhwIjoxNzY0NTEzNTAzfQ.T1lPytBbjr4owP8QBupX6dE-fJu5ae7KrHQ_PBDOP14" },
    { type: "MP3", url: "https://pdkkheetcdvnrsikdses.supabase.co/storage/v1/object/sign/user-files/ea12cfd6-0a51-42f4-9ad6-ba33fff1846f/sample4.mp3?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV84MTRmNzI0Yi1lYzI2LTQ4ZmUtYjk4ZS04Mjk1ZmYxYzBmMGMiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ1c2VyLWZpbGVzL2VhMTJjZmQ2LTBhNTEtNDJmNC05YWQ2LWJhMzNmZmYxODQ2Zi9zYW1wbGU0Lm1wMyIsImlhdCI6MTc2NDQyNzExMywiZXhwIjoxNzY0NTEzNTEzfQ.-GKeKpR6rky-mcH3fH72nzYl9sqMheb79di_4nKGT6o" }
];

const listEle = document.getElementById("music-list");
const stopBtn = document.getElementById("stop-btn");
const statusTxt = document.getElementById("status-text");
const bytesTxt = document.getElementById("bytes-loaded");
let currentPlayer = null;

const visualizer = new Visualizer("visualizer-canvas", (time) => {
    if (currentPlayer) currentPlayer.seek(time);
});

function stopAll() {
    if (currentPlayer) currentPlayer.stop();
    currentPlayer = null;
    visualizer.stop();
    stopBtn.disabled = true;
    statusTxt.textContent = "Stopped";
    bytesTxt.textContent = "0.00 MB";
}

stopBtn.onclick = stopAll;

PLAYLIST.forEach((track, i) => {
    const btn = document.createElement("button");
    btn.className = "text-left w-full p-3 bg-[#111] hover:bg-[#1a1a1a] rounded border border-[#222] hover:border-[#FFD700] flex justify-between items-center group transition-all";
    btn.innerHTML = `
        <span class="text-[#888] font-bold group-hover:text-[#FFD700] text-xs">Track ${i+1}</span>
        <span class="text-[9px] bg-[#222] text-[#666] px-1.5 py-0.5 rounded border border-[#333]">${track.type}</span>
    `;
    
    btn.onclick = () => {
        stopAll();
        stopBtn.disabled = false;
        currentPlayer = PlayerFactory.getPlayer(track.type);
        currentPlayer.play(track.url, (pct, size, status) => {
             statusTxt.textContent = status;
             bytesTxt.textContent = size;
        });
    };
    listEle.appendChild(btn);
});
