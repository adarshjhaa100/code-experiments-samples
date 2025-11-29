// CONFIGURATION
const BUFFER_THRESHOLD = 1024 * 1024; // 1 MB Buffer
const INITIAL_THRESHOLD = 256 * 1024; // 256 KB Start

/**
 * 🎨 VISUALIZER (Standard)
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
 * 🛠 PATCHERS
 */
class AiffHeaderPatcher {
    static patch(view, totalLength) {
        view.setUint32(4, totalLength - 8, false);
        let offset = 12; 
        while (offset < view.byteLength - 8) {
            const chunkId = this.getAscii(view, offset, 4);
            const chunkSize = view.getUint32(offset + 4, false);
            if (chunkId === "SSND") {
                view.setUint32(offset + 4, totalLength - (offset + 8), false); break;
            }
            offset += 8 + chunkSize;
        }
    }
    static getAscii(view, offset, len) {
        let str = "";
        for (let i = 0; i < len; i++) str += String.fromCharCode(view.getUint8(offset + i));
        return str;
    }
}

class WavHeaderPatcher {
    static patch(view, totalLength) {
        view.setUint32(4, totalLength - 8, true);
        let offset = 12;
        while (offset < view.byteLength - 8) {
            const chunkId = this.getAscii(view, offset, 4);
            if (chunkId === "data") {
                view.setUint32(offset + 4, totalLength - (offset + 8), true); break;
            }
            const chunkSize = view.getUint32(offset + 4, true);
            offset += 8 + chunkSize;
        }
    }
    static getAscii(view, offset, len) {
        let str = "";
        for (let i = 0; i < len; i++) str += String.fromCharCode(view.getUint8(offset + i));
        return str;
    }
}

/**
 * 🔈 BASE PLAYER (With Heartbeat Monitor)
 */
class BasePlayer {
    constructor() {
        this.audioCtx = null;
        this.analyser = null;
        this.activeSource = null;
        this.abortController = null;
        this.fullAudioBuffer = null;
        this.visualizer = null;
        
        // Logic State
        this.isStopped = true;
        this.isDownloading = false;
        this.startTime = 0;
        this.playedOffset = 0;
        
        // Duration Logic
        this.totalFileBytes = 0;
        this.estimatedDuration = 0;
        
        // Heartbeat ID
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
        
        // START THE WATCHER
        this.startMonitor();
    }

    // --- HEARTBEAT MONITOR ---
    // This loop checks every 100ms if the audio is dead but shouldn't be.
    startMonitor() {
        if (this.monitorId) clearInterval(this.monitorId);
        
        this.monitorId = setInterval(() => {
            if (this.isStopped) return;
            
            // Sync Visualizer
            if (this.activeSource && this.audioCtx) {
                const now = this.audioCtx.currentTime;
                let cur = this.playedOffset + (now - this.startTime);
                // Clamp display
                if (this.fullAudioBuffer && cur > this.fullAudioBuffer.duration) cur = this.fullAudioBuffer.duration;
                
                this.visualizer.currentTime = cur;
                const dispTotal = this.isDownloading ? this.estimatedDuration : (this.fullAudioBuffer ? this.fullAudioBuffer.duration : 0);
                this.visualizer.updateTime(cur, dispTotal);
            }

            // AUTO-RESUME CHECK
            // If we have a buffer, but NO active source, and we aren't at the end...
            if (this.fullAudioBuffer && !this.activeSource) {
                // Are we at the end of the *full* file?
                const tolerance = 0.2; // 200ms
                if (this.playedOffset < this.fullAudioBuffer.duration - tolerance) {
                    console.log("Heartbeat: Audio died unexpectedly. Reviving...");
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
        if (this.activeSource) {
            this.activeSource.onended = null;
            try { this.activeSource.stop(); } catch(e){}
            this.activeSource = null;
        }
        if (this.audioCtx) { this.audioCtx.close().catch(()=>{}); this.audioCtx = null; }
        this.fullAudioBuffer = null;
        this.playedOffset = 0;
        this.estimatedDuration = 0;
    }

    playSourceFrom(time) {
        if (this.isStopped || !this.fullAudioBuffer || !this.audioCtx) return;

        if (this.activeSource) {
            this.activeSource.onended = null;
            try { this.activeSource.stop(); } catch(e){}
        }

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
            // The Heartbeat monitor will pick this up and restart if needed.
        };
    }

    seek(time) {
        if (this.isStopped || !this.fullAudioBuffer) return;
        time = Math.max(0, Math.min(time, this.fullAudioBuffer.duration - 0.1));
        this.playSourceFrom(time);
    }
}

/**
 * 🌊 STREAM PLAYER
 */
class StreamPlayer extends BasePlayer {
    constructor(type) {
        super();
        this.type = type;
        if (type === "WAV" || type === "AIFF") {
            this.INITIAL_THRESHOLD = 1024 * 1024; 
        } else {
            this.INITIAL_THRESHOLD = 256 * 1024; 
        }
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
            
            let chunks = []; 
            let totalBytes = 0; 
            let lastProcessedBytes = 0;
            let isFirstProcessing = true;

            while (true) {
                const { done, value } = await reader.read();
                if (this.isStopped) return;
                
                if (done) {
                    this.isDownloading = false;
                    if (totalBytes > lastProcessedBytes) {
                        await this.process(chunks, totalBytes, true);
                    }
                    break;
                }

                chunks.push(value);
                totalBytes += value.length;
                
                onProgress((totalBytes/this.totalFileBytes)*100, (totalBytes/1024/1024).toFixed(2) + " MB", `Buffering ${this.type}...`);

                const newBytes = totalBytes - lastProcessedBytes;
                const threshold = isFirstProcessing ? this.INITIAL_THRESHOLD : BUFFER_THRESHOLD;

                if (newBytes >= threshold) {
                    await this.process(chunks, totalBytes, false);
                    lastProcessedBytes = totalBytes;
                    isFirstProcessing = false;
                }
            }
            onProgress(100, "Done", "Playing");

        } catch (e) { 
            if (e.name !== "AbortError") console.error(e); 
        }
    }

    async process(chunks, size, isFinal) {
        if (this.isStopped) return;

        const flat = new Uint8Array(size);
        let off = 0; 
        for (let c of chunks) { flat.set(c, off); off += c.length; }

        if (this.type === "AIFF" && !isFinal) AiffHeaderPatcher.patch(new DataView(flat.buffer), size);
        if (this.type === "WAV" && !isFinal) WavHeaderPatcher.patch(new DataView(flat.buffer), size);

        try {
            const decoded = await this.audioCtx.decodeAudioData(flat.buffer.slice(0));
            this.fullAudioBuffer = decoded;

            // Update Estimate
            if (this.totalFileBytes > 0 && size > 0) {
                this.estimatedDuration = decoded.duration * (this.totalFileBytes / size);
            } else {
                this.estimatedDuration = decoded.duration;
            }

            // Note: We don't force play here anymore. 
            // The Heartbeat monitor will see !activeSource and start it for us immediately.
            
        } catch (e) {
            console.warn("Decode failed, waiting...", e);
        }
    }
}

/**
 * 🏭 FACTORY
 */
class PlayerFactory {
    static getPlayer(type) {
        return new StreamPlayer(type);
    }
}

// DATA (Redacted)
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
