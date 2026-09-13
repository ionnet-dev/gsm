import { createContext, useContext } from "react";

export const PaletteContext = createContext<{ open: () => void }>({ open: () => {} });
export const usePalette = () => useContext(PaletteContext);
