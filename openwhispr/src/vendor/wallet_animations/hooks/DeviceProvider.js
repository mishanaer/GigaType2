export const useSkin = () => ({
  skin: "apple",
  isApple: true,
  isMaterial: false,
  setSkin: () => {},
});

export default function DeviceProvider({ children }) {
  return children;
}
