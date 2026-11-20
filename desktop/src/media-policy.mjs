// Only the dedicated local chat window may request microphone audio.
export function allowChatMicrophone({ permission, currentUrl, requestingUrl, origin, mediaTypes, isMainFrame }) {
  if (permission !== 'media' || isMainFrame === false || !mediaTypes?.length
    || mediaTypes.some(type => type !== 'audio')) return false;
  try {
    const current = new URL(currentUrl);
    return current.origin === origin && current.pathname.startsWith('/chat/')
      && new URL(requestingUrl).origin === origin;
  } catch { return false; }
}
