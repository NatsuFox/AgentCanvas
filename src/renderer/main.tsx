import { createRoot } from "react-dom/client";

import App from "./App";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error("AgentCanvas root element was not found.");
}

createRoot(container).render(<App />);
