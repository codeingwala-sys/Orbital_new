// welcome.js

function showWelcome(username) {
  const layer = document.getElementById("welcome-layer");
  const text = document.getElementById("welcome-text");

  if (!layer || !text) return;

  text.textContent = `Welcome ${username}`;
  layer.style.opacity = "1";

  setTimeout(() => {
    layer.style.opacity = "0";
  }, 3000);
}

// expose globally
window.showWelcome = showWelcome;
