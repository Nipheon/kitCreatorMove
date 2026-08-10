export async function stripWavMetadata(blob: Blob): Promise<Blob> {
  try {
    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);
    
    if (buffer.byteLength < 12) return blob;
    
    const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    
    if (riff !== 'RIFF' || wave !== 'WAVE') return blob;
    
    let offset = 12;
    const chunks = [];
    
    while (offset < buffer.byteLength) {
      if (offset + 8 > buffer.byteLength) break;
      const chunkId = String.fromCharCode(view.getUint8(offset), view.getUint8(offset+1), view.getUint8(offset+2), view.getUint8(offset+3));
      const chunkSize = view.getUint32(offset + 4, true);
      
      if (chunkId === 'fmt ' || chunkId === 'data') {
        chunks.push({
          id: chunkId,
          size: chunkSize,
          data: buffer.slice(offset + 8, offset + 8 + chunkSize)
        });
      }
      
      offset += 8 + chunkSize;
      if (chunkSize % 2 !== 0) {
        offset += 1; // padding byte
      }
    }
    
    // If we didn't find both fmt and data chunks, better to just return the original
    if (!chunks.some(c => c.id === 'fmt ') || !chunks.some(c => c.id === 'data')) {
      return blob;
    }
    
    let newTotalSize = 4; // 'WAVE'
    for (const chunk of chunks) {
      newTotalSize += 8 + chunk.size;
      if (chunk.size % 2 !== 0) {
        newTotalSize += 1;
      }
    }
    
    const outBuffer = new ArrayBuffer(8 + newTotalSize);
    const outView = new DataView(outBuffer);
    
    // write 'RIFF'
    outView.setUint8(0, 'R'.charCodeAt(0));
    outView.setUint8(1, 'I'.charCodeAt(0));
    outView.setUint8(2, 'F'.charCodeAt(0));
    outView.setUint8(3, 'F'.charCodeAt(0));
    outView.setUint32(4, newTotalSize, true);
    
    // write 'WAVE'
    outView.setUint8(8, 'W'.charCodeAt(0));
    outView.setUint8(9, 'A'.charCodeAt(0));
    outView.setUint8(10, 'V'.charCodeAt(0));
    outView.setUint8(11, 'E'.charCodeAt(0));
    
    let outOffset = 12;
    for (const chunk of chunks) {
      outView.setUint8(outOffset, chunk.id.charCodeAt(0));
      outView.setUint8(outOffset+1, chunk.id.charCodeAt(1));
      outView.setUint8(outOffset+2, chunk.id.charCodeAt(2));
      outView.setUint8(outOffset+3, chunk.id.charCodeAt(3));
      outView.setUint32(outOffset + 4, chunk.size, true);
      
      const chunkData = new Uint8Array(chunk.data);
      const outData = new Uint8Array(outBuffer, outOffset + 8, chunk.size);
      outData.set(chunkData);
      
      outOffset += 8 + chunk.size;
      if (chunk.size % 2 !== 0) {
        outView.setUint8(outOffset, 0); // padding byte
        outOffset += 1;
      }
    }
    
    return new Blob([outBuffer], { type: blob.type });
  } catch (err) {
    console.error("Failed to strip WAV metadata:", err);
    return blob;
  }
}
