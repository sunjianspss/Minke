const backgroundUrl = chrome.runtime.getURL("minke-background.jpeg");

document.documentElement.style.setProperty(
  "--minke-background-image",
  `url("${backgroundUrl}")`,
);
