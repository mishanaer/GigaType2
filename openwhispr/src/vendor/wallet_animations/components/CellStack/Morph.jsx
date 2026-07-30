import { Children } from "react";
import PropTypes from "prop-types";
import * as m from "motion/react-m";

import Cell from "../Cells";
import { TRANSITIONS } from "../../utils/animations";

import { useCellStack } from "./context";
import * as styles from "./CellStack.module.scss";

const TRANSITION = TRANSITIONS.MATERIAL_STANDARD;
const CHEVRON_DURATION_SCALE = 1.5;

const LOGO_FRONT = {
  collapsed: { scale: 0.6, x: -6, y: -6 },
  expanded: { scale: 1, x: 0, y: 0 },
};
const LOGO_BEHIND = {
  collapsed: { scale: 0.6, x: 6, y: 6, opacity: 1 },
  expanded: { scale: 0, x: 0, y: 0, opacity: 0 },
};

const readFace = (cell) => {
  const { start, end, children: body } = cell.props;
  return {
    start,
    title: body?.props?.title,
    description: body?.props?.description,
    bold: body?.props?.bold,
    value: end?.props?.title,
  };
};

function Morph({ children, rotateEndOnExpand = false }) {
  const { expanded, spring } = useCellStack();
  const [collapsedFace, expandedFace] = Children.toArray(children).map(readFace);

  const state = expanded ? "expanded" : "collapsed";
  const face = expanded ? expandedFace : collapsedFace;
  const hasStart = Boolean(collapsedFace.start || expandedFace.start);
  const description = face.description;
  const endValue = rotateEndOnExpand ? collapsedFace.value : face.value;
  const rotateTransition = {
    ...spring,
    stiffness: spring.stiffness / CHEVRON_DURATION_SCALE ** 2,
    damping: spring.damping / CHEVRON_DURATION_SCALE,
  };

  return (
    <Cell
      start={
        hasStart ? (
          <div className={styles.logoStack}>
            <m.div
              className={styles.logoFront}
              variants={LOGO_FRONT}
              animate={state}
              transition={TRANSITION}
            >
              {expandedFace.start}
            </m.div>
            <m.div
              className={styles.logoBehind}
              variants={LOGO_BEHIND}
              animate={state}
              transition={TRANSITION}
            >
              {collapsedFace.start}
            </m.div>
          </div>
        ) : undefined
      }
      end={
        endValue && (
          <Cell.Text
            title={
              rotateEndOnExpand ? (
                <m.span
                  className={styles.rotatingEnd}
                  animate={{ rotate: expanded ? 180 : 0 }}
                  transition={rotateTransition}
                >
                  {endValue}
                </m.span>
              ) : (
                endValue
              )
            }
          />
        )
      }
    >
      <Cell.Text
        title={<span className={styles.morphLine}>{face.title}</span>}
        description={description && <span className={styles.morphLine}>{description}</span>}
        bold={face.bold}
      />
    </Cell>
  );
}

Morph.propTypes = {
  children: PropTypes.node.isRequired,
  rotateEndOnExpand: PropTypes.bool,
};

export default Morph;
