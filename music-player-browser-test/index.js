console.log("Initializing Stream Player...");

const sampleFileData = [
    { type: "AIFF", url: "https://pdkkheetcdvnrsikdses.supabase.co/storage/v1/object/sign/user-files/ea12cfd6-0a51-42f4-9ad6-ba33fff1846f/sample4.aiff?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV84MTRmNzI0Yi1lYzI2LTQ4ZmUtYjk4ZS04Mjk1ZmYxYzBmMGMiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ1c2VyLWZpbGVzL2VhMTJjZmQ2LTBhNTEtNDJmNC05YWQ2LWJhMzNmZmYxODQ2Zi9zYW1wbGU0LmFpZmYiLCJpYXQiOjE3NjQ0MjY4OTUsImV4cCI6MTc2NDUxMzI5NX0.umFufQ8e-jgCtLXJbA4qDpVDeBZd6zNGU4OBXKsZ8J0" },
    { type: "FLAC", url: "https://pdkkheetcdvnrsikdses.supabase.co/storage/v1/object/sign/user-files/ea12cfd6-0a51-42f4-9ad6-ba33fff1846f/sample3.flac?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV84MTRmNzI0Yi1lYzI2LTQ4ZmUtYjk4ZS04Mjk1ZmYxYzBmMGMiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ1c2VyLWZpbGVzL2VhMTJjZmQ2LTBhNTEtNDJmNC05YWQ2LWJhMzNmZmYxODQ2Zi9zYW1wbGUzLmZsYWMiLCJpYXQiOjE3NjQ0MjcwOTUsImV4cCI6MTc2NDUxMzQ5NX0.c6qaIX5TpLJIGQJ3HfLIH7e3brnC39lEUVpjYPbXqME" },
    { type: "WAV", url: "https://pdkkheetcdvnrsikdses.supabase.co/storage/v1/object/sign/user-files/ea12cfd6-0a51-42f4-9ad6-ba33fff1846f/sample4.wav?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV84MTRmNzI0Yi1lYzI2LTQ4ZmUtYjk4ZS04Mjk1ZmYxYzBmMGMiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ1c2VyLWZpbGVzL2VhMTJjZmQ2LTBhNTEtNDJmNC05YWQ2LWJhMzNmZmYxODQ2Zi9zYW1wbGU0LndhdiIsImlhdCI6MTc2NDQyNzEwMywiZXhwIjoxNzY0NTEzNTAzfQ.T1lPytBbjr4owP8QBupX6dE-fJu5ae7KrHQ_PBDOP14" },
    { type: "MP3", url: "https://pdkkheetcdvnrsikdses.supabase.co/storage/v1/object/sign/user-files/ea12cfd6-0a51-42f4-9ad6-ba33fff1846f/sample4.mp3?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV84MTRmNzI0Yi1lYzI2LTQ4ZmUtYjk4ZS04Mjk1ZmYxYzBmMGMiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ1c2VyLWZpbGVzL2VhMTJjZmQ2LTBhNTEtNDJmNC05YWQ2LWJhMzNmZmYxODQ2Zi9zYW1wbGU0Lm1wMyIsImlhdCI6MTc2NDQyNzExMywiZXhwIjoxNzY0NTEzNTEzfQ.-GKeKpR6rky-mcH3fH72nzYl9sqMheb79di_4nKGT6o" }
];

// UI Elements
const musicListEle = document.getElementById("music-list");
const statusText = document.getElementById("status-text");
const progressBar = document.getElementById("progress-bar");
const bytesLoadedEle = document.getElementById("bytes-loaded");
const totalSizeEle = document.getElementById("total-size");
const stopBtn = document.getElementById("stop-btn");

// Global Audio Variables
let audioCtx;
let nextStartTime = 0;       // When the next chunk should start playing
let isPlaying = false;
let abortController = null;  // To cancel the fetch request
let sourceNodes = [];        // Keep track of audio nodes to stop them

// --- Helper: Clean up UI and Audio ---
function resetPlayer() {
    if (abortController) abortController.abort();
    
    sourceNodes.forEach(node => {
        try { node.stop(); } catch(e) {}
    });
    sourceNodes = [];
    
    if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
    }

    isPlaying = false;
    stopBtn.disabled = true;
    stopBtn.classList.add("opacity-50", "cursor-not-allowed");
    statusText.textContent = "Stopped.";
    progressBar.style.width = "0%";
}

stopBtn.onclick = resetPlayer;

// --- Helper: Initialize Audio Context ---
function initAudio() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    nextStartTime = 0;
}

// --- Main Function: Render Buttons ---
sampleFileData.forEach((file, index) => {
    const btn = document.createElement("button");
    btn.innerHTML = `
        <span class="font-bold">Track ${index + 1}</span> 
        <span class="text-xs bg-slate-700 px-2 py-0.5 rounded ml-2">${file.type}</span>
    `;
    // Tailwind classes for the buttons
    btn.className = "w-full text-left bg-slate-700 hover:bg-slate-600 text-white p-3 rounded-lg transition-all border border-slate-600 flex items-center shadow-md active:scale-95";

    btn.onclick = () => playChunkedAudio(file);
    musicListEle.appendChild(btn);
});


// --- Core Logic: Fetch and Play Chunks ---
async function playChunkedAudio(file) {
    resetPlayer(); // Stop anything currently running
    initAudio();
    
    stopBtn.disabled = false;
    stopBtn.classList.remove("opacity-50", "cursor-not-allowed");
    
    statusText.textContent = `Connecting to ${file.type}...`;
    isPlaying = true;
    abortController = new AbortController();

    try {
        const response = await fetch(file.url, { signal: abortController.signal });
        if (!response.ok) throw new Error("Network response was not ok");

        const contentLength = +response.headers.get('Content-Length');
        totalSizeEle.textContent = contentLength ? (contentLength / (1024 * 1024)).toFixed(2) + " MB" : "? MB";

        const reader = response.body.getReader();
        
        let receivedLength = 0;
        let chunks = []; 
        let lastDecodedSample = 0; // Tracks how much audio we have already scheduled

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            chunks.push(value);
            receivedLength += value.length;

            // Update UI
            const percent = contentLength ? (receivedLength / contentLength) * 100 : 0;
            progressBar.style.width = `${percent}%`;
            bytesLoadedEle.textContent = (receivedLength / (1024 * 1024)).toFixed(2) + " MB";
            statusText.textContent = "Buffering & Playing...";

            // 1. Create a combined buffer of ALL data received so far
            // Note: This is inefficient but necessary for WAV/AIFF as they need headers
            let combinedBuffer = new Uint8Array(receivedLength);
            let position = 0;
            for(let chunk of chunks) {
                combinedBuffer.set(chunk, position);
                position += chunk.length;
            }

            // 2. Decode the CURRENT available data
            // We clone the buffer because decodeAudioData detaches/empties it
            try {
                // We assume the header is in the first chunk, so combinedBuffer is always valid to try decoding
                const audioBuffer = await audioCtx.decodeAudioData(combinedBuffer.buffer.slice(0));
                
                // 3. Play ONLY the new part (Differential Playback)
                scheduleNewSegment(audioBuffer, lastDecodedSample);
                
                // Update our pointer so we don't play the start again
                lastDecodedSample = audioBuffer.length; 

            } catch (err) {
                // It is normal to fail decoding occasionally if a chunk cuts off in the middle of a frame
                console.warn("Waiting for more data to complete audio frame...");
            }
        }
        statusText.textContent = "Download Complete. Playing remaining...";

    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('Fetch aborted');
        } else {
            console.error("Playback error:", error);
            statusText.textContent = "Error: " + error.message;
        }
    }
}

// --- Logic: Schedule the "Diff" ---
function scheduleNewSegment(fullAudioBuffer, startSampleIndex) {
    // If there is no new data to play, return
    if (startSampleIndex >= fullAudioBuffer.length) return;

    // 1. Extract the new PCM data (channels)
    const channels = fullAudioBuffer.numberOfChannels;
    const sampleRate = fullAudioBuffer.sampleRate;
    const newFrameCount = fullAudioBuffer.length - startSampleIndex;
    
    const nextAudioBuffer = audioCtx.createBuffer(channels, newFrameCount, sampleRate);

    for (let channel = 0; channel < channels; channel++) {
        // Get the full data for this channel
        const fullChannelData = fullAudioBuffer.getChannelData(channel);
        // Slice out just the new part
        const newChannelData = fullChannelData.slice(startSampleIndex);
        // Copy into our new small buffer
        nextAudioBuffer.copyToChannel(newChannelData, channel, 0);
    }

    // 2. Create a source node
    const source = audioCtx.createBufferSource();
    source.buffer = nextAudioBuffer;
    source.connect(audioCtx.destination);

    // 3. Schedule it
    // If the audio context time has advanced past our nextStartTime, we must play immediately (lag)
    // Otherwise, we schedule it perfectly at the end of the previous chunk
    const scheduleTime = Math.max(audioCtx.currentTime, nextStartTime);
    
    source.start(scheduleTime);
    
    // Update the next start time to be the end of this chunk
    nextStartTime = scheduleTime + nextAudioBuffer.duration;

    // Track node to stop later
    sourceNodes.push(source);
    
    // Cleanup old nodes to save memory
    source.onended = () => {
        const index = sourceNodes.indexOf(source);
        if (index > -1) sourceNodes.splice(index, 1);
    };
}