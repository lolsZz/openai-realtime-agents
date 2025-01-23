import { RefObject } from "react";

import { ConcurrentProcessor } from './concurrentProcessing';

interface ConnectionOptions {
  enableVAD?: boolean;
  enableConcurrentProcessing?: boolean;
  reconnectAttempts?: number;
  heartbeatInterval?: number;
}

import { PerformanceMonitor } from './performanceMonitoring';
import { AdaptiveOptimizer } from './adaptiveOptimizer';
import { ContextAwarenessSystem } from './contextAwareness';

export async function createRealtimeConnection(
  EPHEMERAL_KEY: string,
  audioElement: RefObject<HTMLAudioElement | null>,
  options: ConnectionOptions = {}
): Promise<{ pc: RTCPeerConnection; dc: RTCDataChannel; processor?: ConcurrentProcessor }> {
  const pc = new RTCPeerConnection();

  pc.ontrack = (e) => {
    if (audioElement.current) {
        audioElement.current.srcObject = e.streams[0];
    }
  };

  const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
  pc.addTrack(ms.getTracks()[0]);

  const dc = pc.createDataChannel("oai-events");

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const baseUrl = "https://api.openai.com/v1/realtime";
  const model = "gpt-4o-realtime-preview-2024-12-17";

  const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
    method: "POST",
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${EPHEMERAL_KEY}`,
      "Content-Type": "application/sdp",
    },
  });

  const answerSdp = await sdpResponse.text();
  const answer: RTCSessionDescriptionInit = {
    type: "answer",
    sdp: answerSdp,
  };

  await pc.setRemoteDescription(answer);

  let processor: ConcurrentProcessor | undefined;
  
  if (options.enableConcurrentProcessing) {
    processor = new ConcurrentProcessor();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    await processor.processAudioStream(stream);
    
    processor.on('audioProcessed', (audioData) => {
      if (dc.readyState === 'open') {
        dc.send(JSON.stringify({
          type: 'audio_data',
          data: Array.from(audioData),
          timestamp: Date.now()
        }));
      }
    });
  }

  // Setup heartbeat
  if (options.heartbeatInterval) {
    setInterval(() => {
      if (dc.readyState === 'open') {
        dc.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
      }
    }, options.heartbeatInterval);
  }

  // Setup reconnection
  if (options.reconnectAttempts) {
    pc.oniceconnectionstatechange = async () => {
      if (pc.iceConnectionState === 'disconnected') {
        let attempts = 0;
        while (attempts < options.reconnectAttempts!) {
          try {
            const { pc: newPc, dc: newDc } = await createRealtimeConnection(
              EPHEMERAL_KEY,
              audioElement,
              options
            );
            pc = newPc;
            dc = newDc;
            break;
          } catch (error) {
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
          }
        }
      }
    };
  }

  // Initialize performance monitoring and optimization
  const monitor = new PerformanceMonitor();
  const optimizer = new AdaptiveOptimizer();
  const contextSystem = new ContextAwarenessSystem(openai);

  // Start monitoring connection quality
  setInterval(() => {
    const connectionQuality = pc.getStats().then(stats => {
      let packetsLost = 0;
      let packetsReceived = 0;
      
      stats.forEach(report => {
        if (report.type === 'inbound-rtp') {
          packetsLost += report.packetsLost || 0;
          packetsReceived += report.packetsReceived || 0;
        }
      });

      const quality = packetsReceived ? 
        (packetsReceived - packetsLost) / packetsReceived : 1;
      
      monitor.recordMetric('connectionQuality', quality);
      optimizer.recordPerformance(quality);

      const config = optimizer.adjustParameters(monitor.getMetricsSummary());
      if (processor) {
        processor.setVADEnabled(config.qualityThreshold > 0.7);
      }
    });
  }, 5000);

  // Monitor response latency
  dc.onmessage = (originalHandler => (event: MessageEvent) => {
    const start = performance.now();
    originalHandler(event);
    const latency = performance.now() - start;
    monitor.recordMetric('responseLatency', latency);
  })(dc.onmessage);

  // Set up context awareness processing
  if (processor) {
    processor.on('transcription', async (transcription: string) => {
      await contextSystem.processTranscription(transcription);
    });
  }

  contextSystem.on('context-updated', (context) => {
    if (dc.readyState === 'open') {
      dc.send(JSON.stringify({
        type: 'context_update',
        data: context,
        timestamp: Date.now()
      }));
    }
  });

  contextSystem.on('context-alert', (alert) => {
    if (dc.readyState === 'open') {
      dc.send(JSON.stringify({
        type: 'context_alert',
        data: alert,
        timestamp: Date.now()
      }));
    }
  });

  return { pc, dc, processor, monitor, optimizer, contextSystem };
} 