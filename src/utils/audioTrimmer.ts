export async function trimSilence(file: File): Promise<Blob | File> {
  try {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    const threshold = 0.005; 
    let startOffset = 0;

    const length = audioBuffer.length;
    const channels = audioBuffer.numberOfChannels;
    let found = false;

    for (let i = 0; i < length; i++) {
      for (let c = 0; c < channels; c++) {
        if (Math.abs(audioBuffer.getChannelData(c)[i]) > threshold) {
          startOffset = i;
          found = true;
          break;
        }
      }
      if (found) break;
    }

    if (startOffset === 0) {
      return file; 
    }

    const trimmedLength = length - startOffset;
    if (trimmedLength <= 0) return file;

    const trimmedBuffer = audioContext.createBuffer(
      channels,
      trimmedLength,
      audioBuffer.sampleRate
    );

    for (let c = 0; c < channels; c++) {
      trimmedBuffer.getChannelData(c).set(audioBuffer.getChannelData(c).subarray(startOffset, length));
    }

    return encodeWAV(trimmedBuffer);
  } catch (err) {
    console.error("Failed to trim silence", err);
    return file;
  }
}

function encodeWAV(audioBuffer: AudioBuffer): Blob {
  const numOfChan = audioBuffer.numberOfChannels;
  const length = audioBuffer.length * numOfChan * 2 + 44;
  const buffer = new ArrayBuffer(length);
  const view = new DataView(buffer);
  const channels = [];
  let sample = 0;
  let offset = 0;
  let pos = 0;

  function setUint16(data: number) {
    view.setUint16(pos, data, true);
    pos += 2;
  }

  function setUint32(data: number) {
    view.setUint32(pos, data, true);
    pos += 4;
  }

  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8); // file length - 8
  setUint32(0x45564157); // "WAVE"
  setUint32(0x20746d66); // "fmt " chunk
  setUint32(16); // length = 16
  setUint16(1); // PCM (uncompressed)
  setUint16(numOfChan);
  setUint32(audioBuffer.sampleRate);
  setUint32(audioBuffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
  setUint16(numOfChan * 2); // block-align
  setUint16(16); // 16-bit (hardcoded)
  setUint32(0x61746164); // "data" - chunk
  setUint32(length - pos - 4); // chunk length

  for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
    channels.push(audioBuffer.getChannelData(i));
  }

  while (pos < length) {
    for (let i = 0; i < numOfChan; i++) {
      sample = Math.max(-1, Math.min(1, channels[i][offset]));
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
      view.setInt16(pos, sample, true);
      pos += 2;
    }
    offset++;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
