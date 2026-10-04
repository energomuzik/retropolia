import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

/* v0.78: заголовок вкладки — из кода (index.html не входит в патч src/) */
document.title = "RETRO CHALLENGE GENERATOR — платформа ретро-челленджей";

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
