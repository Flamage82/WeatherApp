import { Navigate, Route, Routes } from "react-router";
import { RadarScreen } from "./radar/RadarScreen";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/radar" replace />} />
      <Route path="/radar" element={<RadarScreen />} />
    </Routes>
  );
}
