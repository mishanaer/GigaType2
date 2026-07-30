// Adapted from IlyaGrshin/wallet_animations (MIT).
import { Children, useRef, useState } from "react";
import PropTypes from "prop-types";
import * as m from "motion/react-m";
import { useSmoothCorners } from "@lisse/react";

import { useSkin } from "../../hooks/DeviceProvider";
import { SPRING } from "../../utils/animations";

import CellStackContext from "./context";
import Morph from "./Morph";
import * as styles from "./CellStack.module.scss";

const APPLE_RADIUS = 26;
const MATERIAL_RADIUS = 16;
const SMOOTHING = 0.6;
const FILL_TRANSITION = { ease: "linear", duration: 0.15 };
const PEEK = 13;
const SCALE_STEP = 0.09;
const FADE_STEP = 0.5;
const FILL_OPACITY = { 1: 0.28, 2: 0.68 };

const getStackVariant = ({ depth, expanded }) => {
  if (expanded || depth < 1) return { y: 0, scale: 1, opacity: 1 };
  return {
    y: depth * PEEK,
    scale: 1 - depth * SCALE_STEP,
    opacity: depth >= 2 ? 0 : 1 - depth * FADE_STEP,
  };
};

const StackCard = ({
  children,
  depth,
  expanded,
  spring,
  isApple,
  total,
  isTrigger,
  onTriggerKeyDown,
}) => {
  const ref = useRef(null);
  useSmoothCorners(
    ref,
    {
      radius: expanded ? 0 : isApple ? APPLE_RADIUS : MATERIAL_RADIUS,
      smoothing: SMOOTHING,
    },
    { autoEffects: false }
  );

  const behind = depth >= 1;

  return (
    <m.div
      ref={ref}
      layout
      className={styles.card}
      data-cell-stack-depth={depth}
      style={{ zIndex: total - depth }}
      animate={getStackVariant({ depth, expanded })}
      transition={spring}
      aria-hidden={behind && !expanded}
      inert={behind && !expanded ? true : undefined}
      role={isTrigger ? "button" : undefined}
      aria-expanded={isTrigger ? expanded : undefined}
      tabIndex={isTrigger ? 0 : undefined}
      onKeyDown={isTrigger ? onTriggerKeyDown : undefined}
    >
      {behind ? (
        <>
          <m.div
            className={styles.fill}
            animate={{ opacity: expanded ? 0 : (FILL_OPACITY[depth] ?? 0) }}
            transition={FILL_TRANSITION}
          />
          <m.div
            className={styles.content}
            animate={{ opacity: expanded ? 1 : 0 }}
            transition={FILL_TRANSITION}
          >
            {children}
          </m.div>
        </>
      ) : (
        children
      )}
    </m.div>
  );
};

StackCard.propTypes = {
  children: PropTypes.node.isRequired,
  depth: PropTypes.number.isRequired,
  expanded: PropTypes.bool.isRequired,
  spring: PropTypes.object.isRequired,
  isApple: PropTypes.bool.isRequired,
  total: PropTypes.number.isRequired,
  isTrigger: PropTypes.bool.isRequired,
  onTriggerKeyDown: PropTypes.func.isRequired,
};

function CellStack({
  children,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
  ariaLabel = "Раскрыть дополнительные настройки",
}) {
  const { isApple } = useSkin();
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const expanded = controlledExpanded ?? internalExpanded;
  const spring = isApple ? SPRING.APPLE : SPRING.MATERIAL;
  const cards = Children.toArray(children);

  const toggle = () => {
    const nextExpanded = !expanded;
    if (controlledExpanded === undefined) setInternalExpanded(nextExpanded);
    onExpandedChange?.(nextExpanded);
  };

  const handleClick = (event) => {
    const card = event.target.closest?.("[data-cell-stack-depth]");
    if (expanded && card?.dataset.cellStackDepth !== "0") return;
    toggle();
  };

  const handleTriggerKeyDown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    toggle();
  };

  return (
    <CellStackContext.Provider value={{ expanded, spring }}>
      <div
        className={styles.root}
        data-expanded={expanded}
        onClick={handleClick}
        role="group"
        aria-label={ariaLabel}
      >
        {cards.map((card, depth) => (
          <StackCard
            key={card.key ?? depth}
            depth={depth}
            expanded={expanded}
            spring={spring}
            isApple={isApple}
            total={cards.length}
            isTrigger={depth === 0}
            onTriggerKeyDown={handleTriggerKeyDown}
          >
            {card}
          </StackCard>
        ))}
      </div>
    </CellStackContext.Provider>
  );
}

CellStack.propTypes = {
  children: PropTypes.node.isRequired,
  defaultExpanded: PropTypes.bool,
  expanded: PropTypes.bool,
  onExpandedChange: PropTypes.func,
  ariaLabel: PropTypes.string,
};

CellStack.Morph = Morph;

export default CellStack;
