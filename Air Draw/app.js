// Elements
const video = document.getElementById('webcam-video');
const canvas = document.getElementById('drawing-canvas');
const ctx = canvas.getContext('2d');
const startBtn = document.getElementById('btn-start-camera');
const setupOverlay = document.getElementById('setup-overlay');
const stateIndicator = document.getElementById('state-indicator');
const stateText = document.getElementById('state-text');
const brushSlider = document.getElementById('brush-slider');
const brushSizeText = document.getElementById('brush-size-text');
const colorPalette = document.getElementById('color-palette');
const virtualCursor = document.getElementById('virtual-cursor');
const clearVisual = document.getElementById('clear-canvas-visual');
const clearProgressCircle = clearVisual.querySelector('.progress-circle');

// Action Buttons
const undoBtn = document.getElementById('btn-undo');
const redoBtn = document.getElementById('btn-redo');
const clearBtn = document.getElementById('btn-clear');

// Application States
let currentState = 'IDLE'; // IDLE, DRAWING, PANNING, CLEARING
let isDrawingMode = false;
let isPinched = false;
let pinchTimes = [];
let wasPanning = false;
let prevMidpoint = { x: 0, y: 0 };
let clearStartTime = null;
let palmCooldown = false;
let hoverCooldown = false;

// Drawing Variables
let strokes = []; // Array of Stroke objects
let redoStrokes = []; // Array of Stroke objects (for redo)
let currentStroke = null;
let currentColor = '#06b6d4'; // Default cyan
let currentWidth = 8;
let panOffset = { x: 0, y: 0 }; // Accumulated panning offset

// Smoothing Filter
let smoothedIndex = { x: 0, y: 0 };
let isFirstFrame = true;

// Debouncing Frames
let pinchFrames = 0;
let releaseFrames = 0;

// Neon Color Swatches Configuration
const swatchesConfig = [
  { value: '#06b6d4', name: 'Cyan' },
  { value: '#10b981', name: 'Green' },
  { value: '#f59e0b', name: 'Orange' },
  { value: '#ec4899', name: 'Pink' },
  { value: '#8b5cf6', name: 'Purple' },
  { value: '#ef4444', name: 'Red' },
  { value: '#ffffff', name: 'White' },
  { value: 'eraser', name: 'Eraser' } // Custom Eraser style
];

// Initialize Canvas Size
function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  drawStrokes();
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// HUD Messages
const hud = document.getElementById('hud-message');
let hudTimeout;
function showHUD(text, type = 'info') {
  hud.className = `hud-${type} visible`;
  hud.innerText = text;
  clearTimeout(hudTimeout);
  hudTimeout = setTimeout(() => {
    hud.classList.remove('visible');
  }, 2200);
}

// Distance Helper
function getDistance(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

// Map MediaPipe raw landmarks (0-1) to full-screen mirrored pixels
function mapLandmarkToScreen(lm) {
  const videoWidth = video.videoWidth || 640;
  const videoHeight = video.videoHeight || 480;
  const containerWidth = window.innerWidth;
  const containerHeight = window.innerHeight;

  const videoAspect = videoWidth / videoHeight;
  const containerAspect = containerWidth / containerHeight;

  let scale, dx = 0, dy = 0;
  if (containerAspect > videoAspect) {
    scale = containerWidth / videoWidth;
    dy = (containerHeight - videoHeight * scale) / 2;
  } else {
    scale = containerHeight / videoHeight;
    dx = (containerWidth - videoWidth * scale) / 2;
  }

  // Mirror X-coordinate because the live video feed is scaleX(-1) mirrored
  const mirroredX = 1 - lm.x;
  
  return {
    x: mirroredX * videoWidth * scale + dx,
    y: lm.y * videoHeight * scale + dy,
    z: lm.z
  };
}

// Generate Palette Swatches dynamically
function initPalette() {
  colorPalette.innerHTML = '';
  swatchesConfig.forEach((swatchConf) => {
    const swatch = document.createElement('div');
    swatch.className = 'swatch';
    
    if (swatchConf.value === 'eraser') {
      // Checkerboard styling for eraser
      swatch.style.background = 'repeating-conic-gradient(#555 0% 25%, #222 0% 50%) 50% / 8px 8px';
      swatch.style.setProperty('--swatch-color', '#fff');
      swatch.dataset.color = 'eraser';
    } else {
      swatch.style.backgroundColor = swatchConf.value;
      swatch.style.setProperty('--swatch-color', swatchConf.value);
      swatch.dataset.color = swatchConf.value;
    }
    
    swatch.title = swatchConf.name;
    
    if (swatchConf.value === currentColor) {
      swatch.classList.add('active');
    }

    swatch.addEventListener('click', () => {
      document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      
      if (swatchConf.value === 'eraser') {
        currentColor = 'eraser';
        showHUD('Eraser Activated', 'warning');
      } else {
        currentColor = swatchConf.value;
        showHUD(`Color: ${swatchConf.name}`, 'info');
      }
    });

    colorPalette.appendChild(swatch);
  });
}
initPalette();

// Brush Width Slider listener
brushSlider.addEventListener('input', (e) => {
  currentWidth = parseInt(e.target.value);
  brushSizeText.innerText = currentWidth + 'px';
});

// Canvas Drawing Engine (Render world coordinates + panOffset)
function drawStrokes() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  ctx.save();
  // Translate context by the accumulated pan values
  ctx.translate(panOffset.x, panOffset.y);
  
  strokes.forEach(stroke => {
    if (stroke.points.length === 0) return;
    
    ctx.beginPath();
    
    // Eraser acts as clearing/destination-out, or we draw with background color.
    // Destination-out is superior because it erases lines without painting color!
    if (stroke.color === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)'; // Must be opaque for destination-out
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = stroke.color;
    }
    
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    if (stroke.points.length === 1) {
      ctx.arc(stroke.points[0].x, stroke.points[0].y, stroke.width / 2, 0, Math.PI * 2);
      ctx.fillStyle = stroke.color === 'eraser' ? 'rgba(0,0,0,1)' : stroke.color;
      ctx.fill();
    } else {
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      
      let i;
      for (i = 1; i < stroke.points.length - 1; i++) {
        // Find midpoint between consecutive segments for quadratic bezier curvature
        const xc = (stroke.points[i].x + stroke.points[i + 1].x) / 2;
        const yc = (stroke.points[i].y + stroke.points[i + 1].y) / 2;
        ctx.quadraticCurveTo(stroke.points[i].x, stroke.points[i].y, xc, yc);
      }
      
      // Close path to last point
      ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      ctx.stroke();
    }
  });
  
  ctx.restore();
}

// Action Button Trigger callbacks
undoBtn.addEventListener('click', () => {
  if (strokes.length > 0) {
    const undone = strokes.pop();
    redoStrokes.push(undone);
    drawStrokes();
    showHUD('Stroke Undone', 'info');
  } else {
    showHUD('Nothing to Undo', 'warning');
  }
});

redoBtn.addEventListener('click', () => {
  if (redoStrokes.length > 0) {
    const redone = redoStrokes.pop();
    strokes.push(redone);
    drawStrokes();
    showHUD('Stroke Redone', 'info');
  } else {
    showHUD('Nothing to Redo', 'warning');
  }
});

clearBtn.addEventListener('click', () => {
  if (strokes.length > 0 || panOffset.x !== 0 || panOffset.y !== 0) {
    strokes = [];
    redoStrokes = [];
    panOffset = { x: 0, y: 0 };
    drawStrokes();
    showHUD('Canvas Cleared!', 'danger');
  } else {
    showHUD('Canvas is already empty', 'info');
  }
});

// Air Hover Action Click Logic
const interactiveSelectors = '.swatch, .btn-action, .brush-slider, #btn-start-camera';
let hoveredElement = null;
let hoverStartTime = null;

function handleAirHover(cursorX, cursorY) {
  // Cooldown timer prevents immediate double clicking
  if (hoverCooldown) return;
  
  // Disable clicks while doing action gestures (drawing, panning, clearing)
  if (currentState !== 'IDLE') {
    resetAirHover();
    return;
  }

  const elements = document.querySelectorAll(interactiveSelectors);
  let foundHover = null;

  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (
      cursorX >= rect.left &&
      cursorX <= rect.right &&
      cursorY >= rect.top &&
      cursorY <= rect.bottom
    ) {
      foundHover = element;
      break;
    }
  }

  if (foundHover) {
    if (hoveredElement !== foundHover) {
      resetAirHover();
      hoveredElement = foundHover;
      hoveredElement.classList.add('air-hover');
      hoverStartTime = performance.now();
    } else {
      const elapsed = performance.now() - hoverStartTime;
      const progress = Math.min(1, elapsed / 1000); // 1.0 second hover countdown

      // Update Cursor ring
      const circle = virtualCursor.querySelector('circle');
      if (circle) {
        const offset = 82 - (progress * 82); // 82 is the stroke-dasharray value
        circle.style.strokeDashoffset = offset;
      }

      // Slider continuous value adjust during hover
      if (hoveredElement.classList.contains('brush-slider')) {
        const rect = hoveredElement.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (cursorX - rect.left) / rect.width));
        const min = parseInt(hoveredElement.min);
        const max = parseInt(hoveredElement.max);
        const val = Math.round(min + ratio * (max - min));
        hoveredElement.value = val;
        hoveredElement.dispatchEvent(new Event('input'));
      }

      if (elapsed >= 1000) {
        // Trigger simulated click
        hoveredElement.click();
        
        // Brief styling flash
        hoveredElement.style.transform = 'scale(0.95)';
        setTimeout(() => {
          if (hoveredElement) hoveredElement.style.transform = '';
        }, 100);

        resetAirHover();
        hoverCooldown = true;
        setTimeout(() => { hoverCooldown = false; }, 800);
      }
    }
  } else {
    resetAirHover();
  }
}

function resetAirHover() {
  if (hoveredElement) {
    hoveredElement.classList.remove('air-hover');
  }
  hoveredElement = null;
  hoverStartTime = null;
  const circle = virtualCursor.querySelector('circle');
  if (circle) {
    circle.style.strokeDashoffset = 82;
  }
}

// MediaPipe Results Processor
function onResults(results) {
  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    // Hand tracking lost
    virtualCursor.classList.remove('visible');
    resetAirHover();
    
    // Clear palm erasing states
    clearStartTime = null;
    clearVisual.classList.remove('active');
    
    // Break drawing continuity so lines do not connect awkwardly when hand returns
    if (isDrawingMode && currentStroke) {
      currentStroke = null;
    }
    
    // Keep base state as IDLE when no hand present
    currentState = 'IDLE';
    updateStateUI();
    return;
  }

  // Show cursor since hand is tracked
  virtualCursor.classList.add('visible');

  // Grab the first tracked hand
  const rawLandmarks = results.multiHandLandmarks[0];

  // Map landmarks to matched screen coordinates
  const wrist = mapLandmarkToScreen(rawLandmarks[0]);
  const thumbTip = mapLandmarkToScreen(rawLandmarks[4]);
  const indexMcp = mapLandmarkToScreen(rawLandmarks[5]);
  const indexPip = mapLandmarkToScreen(rawLandmarks[6]);
  const indexTip = mapLandmarkToScreen(rawLandmarks[8]);
  
  const middleMcp = mapLandmarkToScreen(rawLandmarks[9]);
  const middlePip = mapLandmarkToScreen(rawLandmarks[10]);
  const middleTip = mapLandmarkToScreen(rawLandmarks[12]);
  
  const ringPip = mapLandmarkToScreen(rawLandmarks[14]);
  const ringTip = mapLandmarkToScreen(rawLandmarks[16]);
  
  const pinkyMcp = mapLandmarkToScreen(rawLandmarks[17]);
  const pinkyPip = mapLandmarkToScreen(rawLandmarks[18]);
  const pinkyTip = mapLandmarkToScreen(rawLandmarks[20]);

  // Smooth Coordinates for Index fingertip
  if (isFirstFrame) {
    smoothedIndex.x = indexTip.x;
    smoothedIndex.y = indexTip.y;
    isFirstFrame = false;
  } else {
    const alpha = 0.35; // Smoothing coefficient
    smoothedIndex.x = alpha * indexTip.x + (1 - alpha) * smoothedIndex.x;
    smoothedIndex.y = alpha * indexTip.y + (1 - alpha) * smoothedIndex.y;
  }

  // Move visual virtual cursor
  virtualCursor.style.left = smoothedIndex.x + 'px';
  virtualCursor.style.top = smoothedIndex.y + 'px';

  // Compute reference hand size for distance normalization
  const handSize = Math.max(getDistance(wrist, middleMcp), 15);

  // GESTURE CLASSIFIER: FINGER EXTENSION FLAGS
  const indexExtended = getDistance(indexTip, wrist) > getDistance(indexPip, wrist);
  const middleExtended = getDistance(middleTip, wrist) > getDistance(middlePip, wrist);
  const ringExtended = getDistance(ringTip, wrist) > getDistance(ringPip, wrist);
  const pinkyExtended = getDistance(pinkyTip, wrist) > getDistance(pinkyPip, wrist);
  
  // Thumb check
  const thumbIp = mapLandmarkToScreen(rawLandmarks[3]);
  const thumbExtended = getDistance(thumbTip, pinkyMcp) > getDistance(thumbIp, pinkyMcp);

  // Gesture Check 1: Palm Clear (All 5 open)
  const palmGesture = indexExtended && middleExtended && ringExtended && pinkyExtended && thumbExtended;
  
  // Gesture Check 2: Two-Finger Panning (Index + Middle extended, ring/pinky closed, fingertips close)
  const panGesture = indexExtended && middleExtended && !ringExtended && !pinkyExtended && 
                     (getDistance(indexTip, middleTip) / handSize < 0.35);

  // Gesture Check 3: Pinch (Index tip close to thumb tip)
  const pinchDist = getDistance(indexTip, thumbTip) / handSize;
  const rawPinch = pinchDist < 0.23;

  // Debounce raw pinch to filter frame noise
  if (rawPinch) {
    pinchFrames++;
    releaseFrames = 0;
  } else {
    releaseFrames++;
    pinchFrames = 0;
  }

  let pinchActive = isPinched;
  if (pinchFrames >= 2) pinchActive = true;
  if (releaseFrames >= 2) pinchActive = false;

  // Double Pinch Detect on Edge Transitions
  if (pinchActive && !isPinched) {
    const now = performance.now();
    pinchTimes.push(now);
    
    // Clear timestamps older than 500ms
    pinchTimes = pinchTimes.filter(t => now - t < 500);

    if (pinchTimes.length === 2) {
      isDrawingMode = !isDrawingMode;
      pinchTimes = []; // Flush
      showHUD(isDrawingMode ? 'Drawing Mode: ON' : 'Drawing Mode: OFF', isDrawingMode ? 'success' : 'warning');
      
      if (isDrawingMode) {
        // Start a fresh stroke
        const worldX = smoothedIndex.x - panOffset.x;
        const transformY = smoothedIndex.y - panOffset.y;
        currentStroke = {
          points: [{ x: worldX, y: transformY }],
          color: currentColor,
          width: currentWidth
        };
        strokes.push(currentStroke);
        redoStrokes = []; // Reset redo
      } else {
        currentStroke = null;
      }
    }
  }
  isPinched = pinchActive;

  // STATE MACHINE & ACTIONS
  if (palmGesture && !palmCooldown) {
    // 1. CLEARING STATE
    currentState = 'CLEARING';
    isDrawingMode = false;
    currentStroke = null;
    
    if (clearStartTime === null) {
      clearStartTime = performance.now();
    }
    
    const elapsed = performance.now() - clearStartTime;
    const progress = Math.min(1, elapsed / 1500); // 1.5 second hold threshold
    
    // Position erasing progress ring at palm center (middleMcp)
    clearVisual.style.left = middleMcp.x + 'px';
    clearVisual.style.top = middleMcp.y + 'px';
    clearVisual.classList.add('active');
    
    // Update progress circle offset (circumference = 251.2)
    const offset = 251.2 * (1 - progress);
    clearProgressCircle.style.strokeDashoffset = offset;
    
    if (elapsed >= 1500) {
      strokes = [];
      redoStrokes = [];
      panOffset = { x: 0, y: 0 };
      drawStrokes();
      showHUD('Canvas Cleared!', 'danger');
      clearStartTime = null;
      clearVisual.classList.remove('active');
      palmCooldown = true; // Block repeated triggering until hand closes
    }
  } else {
    // Stop clearing counter if gesture dropped
    clearStartTime = null;
    clearVisual.classList.remove('active');
    
    if (!palmGesture) {
      palmCooldown = false;
    }

    if (panGesture) {
      // 2. PANNING STATE
      currentState = 'PANNING';
      isDrawingMode = false;
      currentStroke = null;
      
      const midPoint = {
        x: (indexTip.x + middleTip.x) / 2,
        y: (indexTip.y + middleTip.y) / 2
      };

      if (wasPanning) {
        const dx = midPoint.x - prevMidpoint.x;
        const dy = midPoint.y - prevMidpoint.y;
        panOffset.x += dx;
        panOffset.y += dy;
      }
      
      prevMidpoint = midPoint;
      wasPanning = true;
    } else {
      wasPanning = false;

      if (isDrawingMode) {
        // 3. DRAWING STATE
        currentState = 'DRAWING';
        
        const worldX = smoothedIndex.x - panOffset.x;
        const worldY = smoothedIndex.y - panOffset.y;
        
        if (!currentStroke) {
          currentStroke = {
            points: [{ x: worldX, y: worldY }],
            color: currentColor,
            width: currentWidth
          };
          strokes.push(currentStroke);
        } else {
          // Prevent adding duplicate close points
          const lastPoint = currentStroke.points[currentStroke.points.length - 1];
          if (getDistance({x: worldX, y: worldY}, lastPoint) > 1.5) {
            currentStroke.points.push({ x: worldX, y: worldY });
          }
        }
      } else {
        // 4. IDLE STATE
        currentState = 'IDLE';
      }
    }
  }

  // Update Indicator Layouts & virtual cursor graphics
  updateStateUI();

  // Run Air Hover detector over button coordinates
  handleAirHover(smoothedIndex.x, smoothedIndex.y);
}

function updateStateUI() {
  stateIndicator.className = 'state-badge';
  virtualCursor.className = '';
  
  if (virtualCursor.classList.contains('visible') === false) {
    virtualCursor.classList.add('visible');
  }

  switch (currentState) {
    case 'IDLE':
      stateIndicator.classList.add('active-idle');
      stateText.innerText = 'IDLE';
      break;
    case 'DRAWING':
      stateIndicator.classList.add('active-draw');
      stateText.innerText = 'DRAWING';
      virtualCursor.classList.add('drawing');
      break;
    case 'PANNING':
      stateIndicator.classList.add('active-pan');
      stateText.innerText = 'PANNING';
      virtualCursor.classList.add('panning');
      break;
    case 'CLEARING':
      stateIndicator.classList.add('active-clear');
      stateText.innerText = 'CLEARING';
      break;
  }
}

// Global Animation Frame Render Loop for drawing canvas
function renderLoop() {
  drawStrokes();
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

// Start Camera Hook
startBtn.addEventListener('click', async () => {
  // Check if MediaPipe is loaded
  if (typeof Hands === 'undefined') {
    alert('Hand tracking library (MediaPipe) failed to load. Please check your network and try again.');
    return;
  }

  startBtn.classList.add('loading');
  startBtn.disabled = true;

  try {
    // Initial request for camera stream to trigger system permission dialog
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720 }
    });
    
    // Assign stream to video tag
    video.srcObject = stream;
    
    // Initialize MediaPipe Hands
    const hands = new Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });

    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.7
    });

    hands.onResults(onResults);

    // Setup MediaPipe Camera helper using our video element
    const camera = new Camera(video, {
      onFrame: async () => {
        await hands.send({ image: video });
      },
      width: 1280,
      height: 720
    });

    // Start tracking loop
    await camera.start();

    // Trigger UI transitions once camera starts successfully
    setTimeout(() => {
      setupOverlay.classList.add('fade-out');
      video.classList.add('active');
      showHUD('Hand tracking started. Double pinch in air to draw!', 'success');
    }, 1000);

  } catch (err) {
    console.error('Camera startup failed:', err);
    startBtn.classList.remove('loading');
    startBtn.disabled = false;
    alert(`Could not start webcam: ${err.message || err}. Please ensure camera access is granted.`);
  }
});
