import { createRoot } from "react-dom/client";
import App from "./App";

// Vite 页面只提供一个 root 容器，React 从这里挂载整个聊天应用。
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
