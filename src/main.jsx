import React from "react";
import ReactDOM from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import App from "./App.jsx";

const theme = {
  primaryColor: "brand",
  colors: {
    brand: [
      "#f0feff",
      "#dffbff",
      "#b3ebf2",
      "#86dce8",
      "#5ecde0",
      "#3fbfd6",
      "#2eb5cf",
      "#1c9aaa",
      "#137a89",
      "#0c5c68",
    ],
  },
  defaultRadius: "md",
};

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <MantineProvider theme={theme}>
      <App />
    </MantineProvider>
  </React.StrictMode>
);
