/**
 * Forwards captured microphone frames to the page.
 *
 * A worklet rather than a ScriptProcessorNode: capture runs on the audio thread,
 * so a busy render pass drops frames from the recording rather than from the
 * screen. It is loaded as a same-origin asset because the renderer's CSP is
 * `script-src 'self'`, which a blob: worklet would violate.
 *
 * Resampling is not done here. The page opens its AudioContext at 16 kHz and
 * lets the browser resample, so these frames are already the rate Veil wants.
 */
class PCMTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    // A copy, not the view: the render quantum's buffer is reused by the audio
    // thread the moment this returns.
    if (channel?.length) this.port.postMessage(new Float32Array(channel));
    return true;
  }
}

registerProcessor("pcm-tap", PCMTap);
