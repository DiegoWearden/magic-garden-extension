// Paste this into the browser console while on magiccircle.gg
// It will log all WebSocket connection details including cookies

(function() {
  const originalWebSocket = window.WebSocket;
  
  window.WebSocket = function(url, protocols) {
    console.log('=== WebSocket Connection ===');
    console.log('URL:', url);
    console.log('Protocols:', protocols);
    console.log('Cookies:', document.cookie);
    console.log('User-Agent:', navigator.userAgent);
    
    const ws = new originalWebSocket(url, protocols);
    
    // Log first few messages
    let msgCount = 0;
    ws.addEventListener('message', function(e) {
      msgCount++;
      if (msgCount <= 5) {
        console.log(`Message ${msgCount}:`, e.data.substring(0, 500));
      }
    });
    
    ws.addEventListener('open', function() {
      console.log('WebSocket opened');
    });
    
    ws.addEventListener('close', function(e) {
      console.log('WebSocket closed:', e.code, e.reason);
    });
    
    return ws;
  };
  
  console.log('WebSocket capture installed. Now join a room!');
})();

