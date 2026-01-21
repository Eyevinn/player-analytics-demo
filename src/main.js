import Hls from 'hls.js';
import shaka from 'shaka-player';
import webplayer from '@eyevinn/web-player';
import '@eyevinn/web-player/dist/webplayer.css';
import { PlayerAnalyticsConnector } from '@eyevinn/player-analytics-client-sdk-web';

// Configuration
const SHARD_ID = 'epasdemo';
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const DEFAULT_EVENTSINK_URL = import.meta.env.VITE_EVENTSINK_URL || 'https://eyevinnlab-epasdev.eyevinn-player-analytics-eventsink.auto.prod.osaas.io';
const CLICKHOUSE_URL = import.meta.env.VITE_CLICKHOUSE_URL || 'https://eyevinnlab-epasdev.clickhouse-clickhouse.auto.prod.osaas.io';
const CLICKHOUSE_USERNAME = import.meta.env.VITE_CLICKHOUSE_USERNAME || 'epasdev';
const CLICKHOUSE_PASSWORD = import.meta.env.VITE_CLICKHOUSE_PASSWORD || 'epasdev';

// DOM Elements
const playerSelect = document.getElementById('player-select');
const eventsinkUrlInput = document.getElementById('eventsink-url');
const videoUrlInput = document.getElementById('video-url');
const contentTitleInput = document.getElementById('content-title');
const loadBtn = document.getElementById('load-btn');
const stopBtn = document.getElementById('stop-btn');
const videoContainer = document.getElementById('video-container');
let videoElement = document.getElementById('video-player');
const sessionIdDisplay = document.getElementById('session-id');
const currentPlayerDisplay = document.getElementById('current-player');
const statusDisplay = document.getElementById('status');
const eventsLog = document.getElementById('events-log');
const clearEventsBtn = document.getElementById('clear-events');

// Database DOM Elements
const refreshDbBtn = document.getElementById('refresh-db');
const dbTableName = document.getElementById('db-table-name');
const dbRowCount = document.getElementById('db-row-count');
const eventsTableBody = document.getElementById('events-table-body');

// State
let currentPlayer = null;
let hlsInstance = null;
let shakaInstance = null;
let eyevinnInstance = null;
let eyevinnDestroy = null;
let analyticsConnector = null;
let sessionId = null;

// Generate unique session ID
function generateSessionId() {
  return `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// Format timestamp for display
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  });
}

// Log event to UI
function logEvent(eventType, payload = {}) {
  // Remove placeholder if present
  const placeholder = eventsLog.querySelector('.event-placeholder');
  if (placeholder) {
    placeholder.remove();
  }

  const eventItem = document.createElement('div');
  eventItem.className = `event-item event-${eventType}`;

  const timestamp = Date.now();
  const details = Object.keys(payload).length > 0
    ? JSON.stringify(payload, null, 0).substring(0, 200)
    : '';

  eventItem.innerHTML = `
    <div class="event-header">
      <span class="event-type">${eventType}</span>
      <span class="event-time">${formatTime(timestamp)}</span>
    </div>
    ${details ? `<div class="event-details">${details}</div>` : ''}
  `;

  eventsLog.insertBefore(eventItem, eventsLog.firstChild);

  // Keep only last 100 events
  while (eventsLog.children.length > 100) {
    eventsLog.removeChild(eventsLog.lastChild);
  }
}

// Update status display
function updateStatus(status, className) {
  statusDisplay.textContent = status;
  statusDisplay.className = `value ${className}`;
}

// Destroy current player
function destroyCurrentPlayer() {
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }

  if (shakaInstance) {
    shakaInstance.destroy();
    shakaInstance = null;
  }

  if (eyevinnDestroy) {
    eyevinnDestroy();
    eyevinnDestroy = null;
    eyevinnInstance = null;
  }

  if (analyticsConnector) {
    try {
      analyticsConnector.deinit();
    } catch (e) {
      console.warn('Error deinitializing analytics:', e);
    }
    analyticsConnector = null;
  }

  // Reset video container
  videoContainer.innerHTML = '<video id="video-player" controls playsinline></video>';
  videoElement = document.getElementById('video-player');

  currentPlayer = null;
  currentPlayerDisplay.textContent = '-';
  sessionIdDisplay.textContent = '-';
  updateStatus('Idle', 'status-idle');
}

// Create analytics connector with event interception
function createAnalyticsConnector(eventsinkUrl) {
  // Create a custom fetch wrapper to intercept events
  const originalFetch = window.fetch;
  window.fetch = function(url, options) {
    if (url.toString().includes(eventsinkUrl) && options?.body) {
      try {
        const event = JSON.parse(options.body);
        logEvent(event.event, {
          playhead: event.playhead,
          duration: event.duration,
          ...(event.payload || {})
        });
      } catch (e) {
        // Ignore parse errors
      }
    }
    return originalFetch.apply(this, arguments);
  };

  return new PlayerAnalyticsConnector(eventsinkUrl);
}

// Setup video element event listeners for additional logging
function setupVideoEventListeners() {
  // These complement the SDK's automatic tracking
  videoElement.addEventListener('play', () => {
    updateStatus('Playing', 'status-playing');
  });

  videoElement.addEventListener('pause', () => {
    updateStatus('Paused', 'status-paused');
  });

  videoElement.addEventListener('waiting', () => {
    updateStatus('Buffering', 'status-loading');
  });

  videoElement.addEventListener('playing', () => {
    updateStatus('Playing', 'status-playing');
  });

  videoElement.addEventListener('error', () => {
    updateStatus('Error', 'status-error');
  });

  videoElement.addEventListener('ended', () => {
    updateStatus('Ended', 'status-paused');
  });
}

// Initialize HLS.js player
async function initHlsPlayer(videoUrl) {
  if (!Hls.isSupported()) {
    throw new Error('HLS.js is not supported in this browser');
  }

  hlsInstance = new Hls({
    debug: false,
    enableWorker: true
  });

  hlsInstance.loadSource(videoUrl);
  hlsInstance.attachMedia(videoElement);

  // Track bitrate changes
  hlsInstance.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
    const level = hlsInstance.levels[data.level];
    if (level && analyticsConnector) {
      analyticsConnector.reportBitrateChange({
        bitrate: Math.round(level.bitrate / 1000),
        width: level.width,
        height: level.height
      });
    }
  });

  // Track errors
  hlsInstance.on(Hls.Events.ERROR, (event, data) => {
    if (data.fatal) {
      analyticsConnector?.reportError({
        category: data.type,
        code: data.details,
        message: data.reason || 'HLS.js fatal error'
      });
    } else {
      analyticsConnector?.reportWarning({
        category: data.type,
        code: data.details,
        message: data.reason || 'HLS.js warning'
      });
    }
  });

  return new Promise((resolve, reject) => {
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      resolve();
    });
    hlsInstance.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        reject(new Error(`HLS error: ${data.details}`));
      }
    });
  });
}

// Initialize Shaka Player
async function initShakaPlayer(videoUrl) {
  shaka.polyfill.installAll();

  if (!shaka.Player.isBrowserSupported()) {
    throw new Error('Shaka Player is not supported in this browser');
  }

  shakaInstance = new shaka.Player();
  await shakaInstance.attach(videoElement);

  // Track bitrate changes
  shakaInstance.addEventListener('adaptation', () => {
    const tracks = shakaInstance.getVariantTracks();
    const activeTrack = tracks.find(t => t.active);
    if (activeTrack && analyticsConnector) {
      analyticsConnector.reportBitrateChange({
        bitrate: Math.round((activeTrack.bandwidth || 0) / 1000),
        width: activeTrack.width,
        height: activeTrack.height,
        videoBitrate: Math.round((activeTrack.videoBandwidth || 0) / 1000),
        audioBitrate: Math.round((activeTrack.audioBandwidth || 0) / 1000)
      });
    }
  });

  // Track errors
  shakaInstance.addEventListener('error', (event) => {
    const error = event.detail;
    analyticsConnector?.reportError({
      category: `shaka-${error.category}`,
      code: error.code.toString(),
      message: error.message || 'Shaka Player error'
    });
  });

  await shakaInstance.load(videoUrl);
}

// Initialize Eyevinn Web Player
async function initEyevinnPlayer(videoUrl) {
  // Clear the container for Eyevinn player
  videoContainer.innerHTML = '';

  const { player, destroy } = webplayer(videoContainer, {});
  eyevinnInstance = player;
  eyevinnDestroy = destroy;

  await player.load(videoUrl);

  // Get the video element created by the Eyevinn player
  videoElement = videoContainer.querySelector('video');

  if (!videoElement) {
    throw new Error('Could not find video element in Eyevinn player');
  }
}

// Load video with selected player
async function loadVideo() {
  const selectedPlayer = playerSelect.value;
  const eventsinkUrl = eventsinkUrlInput.value.trim();
  const videoUrl = videoUrlInput.value.trim();
  const contentTitle = contentTitleInput.value.trim();

  if (!eventsinkUrl || !videoUrl) {
    alert('Please enter both Eventsink URL and Video URL');
    return;
  }

  // Destroy any existing player
  destroyCurrentPlayer();

  // Generate new session ID
  sessionId = generateSessionId();
  sessionIdDisplay.textContent = sessionId;
  const playerNames = {
    eyevinn: 'Eyevinn Web Player',
    hlsjs: 'HLS.js',
    shaka: 'Shaka Player'
  };
  currentPlayerDisplay.textContent = playerNames[selectedPlayer] || selectedPlayer;
  updateStatus('Loading', 'status-loading');

  loadBtn.disabled = true;
  stopBtn.disabled = true;

  try {
    // Create analytics connector
    analyticsConnector = createAnalyticsConnector(eventsinkUrl);

    // Initialize analytics session
    await analyticsConnector.init({
      sessionId: sessionId,
      shardId: SHARD_ID,
      heartbeatInterval: HEARTBEAT_INTERVAL
    });

    // Initialize the selected player
    if (selectedPlayer === 'eyevinn') {
      await initEyevinnPlayer(videoUrl);
      currentPlayer = 'eyevinn';
    } else if (selectedPlayer === 'hlsjs') {
      await initHlsPlayer(videoUrl);
      currentPlayer = 'hlsjs';
    } else {
      await initShakaPlayer(videoUrl);
      currentPlayer = 'shaka';
    }

    // Attach analytics to video element
    analyticsConnector.load(videoElement);

    // Send metadata
    analyticsConnector.reportMetadata({
      contentTitle: contentTitle || 'Demo Video',
      contentUrl: videoUrl,
      live: false,
      deviceType: 'desktop',
      deviceModel: navigator.userAgent.includes('Mac') ? 'Mac' : 'Windows'
    });

    setupVideoEventListeners();
    updateStatus('Loaded', 'status-paused');
    stopBtn.disabled = false;

  } catch (error) {
    console.error('Error loading video:', error);
    updateStatus('Error', 'status-error');
    logEvent('error', { message: error.message });
    destroyCurrentPlayer();
  } finally {
    loadBtn.disabled = false;
  }
}

// Stop current session
function stopSession() {
  if (analyticsConnector) {
    analyticsConnector.reportStop();
  }
  destroyCurrentPlayer();
  updateStatus('Stopped', 'status-idle');
}

// Clear events log
function clearEvents() {
  eventsLog.innerHTML = '<div class="event-placeholder">Events will appear here when video starts playing...</div>';
}

// Event listeners
loadBtn.addEventListener('click', loadVideo);
stopBtn.addEventListener('click', stopSession);
clearEventsBtn.addEventListener('click', clearEvents);

// Handle page unload
window.addEventListener('beforeunload', () => {
  if (analyticsConnector) {
    analyticsConnector.reportStop();
  }
});

// Initialize Shaka polyfills on page load
shaka.polyfill.installAll();

// Set default eventsink URL from environment variable
eventsinkUrlInput.value = DEFAULT_EVENTSINK_URL;

// ClickHouse Database Functions
const TABLE_NAME = `epas_${SHARD_ID}`;

// Update table name display
dbTableName.textContent = TABLE_NAME;

// Query ClickHouse database
async function queryClickHouse(query) {
  const url = `${CLICKHOUSE_URL}/?default_format=JSON`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${CLICKHOUSE_USERNAME}:${CLICKHOUSE_PASSWORD}`),
      'Content-Type': 'text/plain'
    },
    body: query
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ClickHouse error: ${errorText}`);
  }

  return response.json();
}

// Format timestamp from ClickHouse
function formatDbTimestamp(timestamp) {
  if (!timestamp) return '-';
  const date = new Date(timestamp);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

// Render table rows
function renderTableRows(data) {
  if (!data || data.length === 0) {
    eventsTableBody.innerHTML = `
      <tr class="placeholder-row">
        <td colspan="6">No events found in the database</td>
      </tr>
    `;
    dbRowCount.textContent = '0';
    return;
  }

  dbRowCount.textContent = data.length.toString();

  eventsTableBody.innerHTML = data.map(row => {
    const payload = row.payload ? JSON.stringify(row.payload).substring(0, 100) : '-';
    return `
      <tr>
        <td>${formatDbTimestamp(row.timestamp)}</td>
        <td title="${row.sessionId || ''}">${(row.sessionId || '-').substring(0, 20)}...</td>
        <td><span class="event-badge ${row.event || ''}">${row.event || '-'}</span></td>
        <td>${row.playhead ?? '-'}</td>
        <td>${row.duration ?? '-'}</td>
        <td title="${payload}">${payload}</td>
      </tr>
    `;
  }).join('');
}

// Refresh data from ClickHouse
async function refreshDatabase() {
  refreshDbBtn.disabled = true;
  refreshDbBtn.textContent = 'Loading...';

  try {
    const query = `SELECT * FROM ${TABLE_NAME} ORDER BY timestamp DESC LIMIT 100`;
    const result = await queryClickHouse(query);
    renderTableRows(result.data || []);
  } catch (error) {
    console.error('Error querying ClickHouse:', error);
    eventsTableBody.innerHTML = `
      <tr class="placeholder-row">
        <td colspan="6" style="color: var(--error);">Error: ${error.message}</td>
      </tr>
    `;
    dbRowCount.textContent = '-';
  } finally {
    refreshDbBtn.disabled = false;
    refreshDbBtn.textContent = 'Refresh Data';
  }
}

// Database event listeners
refreshDbBtn.addEventListener('click', refreshDatabase);

console.log('Eyevinn Open Analytics Demo initialized');
console.log('Shard ID:', SHARD_ID);
console.log('Eventsink URL:', DEFAULT_EVENTSINK_URL);
console.log('ClickHouse URL:', CLICKHOUSE_URL);
console.log('Table Name:', TABLE_NAME);

// Export configuration for external use
export const config = {
  shardId: SHARD_ID,
  eventsinkUrl: DEFAULT_EVENTSINK_URL,
  clickhouse: {
    url: CLICKHOUSE_URL,
    username: CLICKHOUSE_USERNAME,
    password: CLICKHOUSE_PASSWORD
  }
};
