import StartView from "../../vendor/wallet_animations/components/StartView";

const headline = "Всё готово";
const description = "Откройте любую программу, нажмите хоткей и\u00A0начните говорить";

export default function DailyDictationHeadline() {
  return (
    <StartView
      title={headline}
      description={description}
      className="appshots-settings-start-view"
    />
  );
}
