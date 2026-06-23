import Text from "../Text";
import PropTypes from "prop-types";

import * as styles from "./StartView.module.scss";

const StartView = ({ title, description, className = "" }) => {
  return (
    <div className={`${styles.root} ${className}`.trim()}>
      <Text variant="title1" weight="bold">
        {title}
      </Text>
      {description && (
        <div className={styles.description}>
          <Text variant="body" weight="regular">
            {description}
          </Text>
        </div>
      )}
    </div>
  );
};

StartView.propTypes = {
  title: PropTypes.string.isRequired,
  description: PropTypes.string,
  className: PropTypes.string,
};
export default StartView;
