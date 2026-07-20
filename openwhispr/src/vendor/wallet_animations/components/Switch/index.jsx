import { useState } from "react"
import PropTypes from "prop-types"
import * as styles from "./Switch.module.scss"

function Switch({
    value,
    defaultValue = false,
    onChange,
    disabled = false,
    className,
    ariaLabel,
}) {
    const isControlled = value !== undefined
    const [uncontrolled, setUncontrolled] = useState(defaultValue)
    const checked = isControlled ? value : uncontrolled

    const emitChange = (next) => {
        if (onChange) onChange(next)
    }

    const toggle = () => {
        if (isControlled) {
            emitChange(!checked)
            return
        }

        setUncontrolled((prev) => {
            const next = !prev
            emitChange(next)
            return next
        })
    }

    const handleClick = (e) => {
        e.stopPropagation()
        if (disabled) return
        toggle()
    }

    const handleKeyDown = (e) => {
        if (disabled || (e.key !== "Enter" && e.key !== " ")) return
        e.preventDefault()
        e.stopPropagation()
        toggle()
    }

    const cx = className ? `${styles.root} ${className}` : styles.root

    return (
        <div
            className={cx}
            data-state={checked}
            data-disabled={disabled || undefined}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            role="switch"
            aria-checked={checked}
            aria-disabled={disabled || undefined}
            aria-label={ariaLabel}
            tabIndex={disabled ? -1 : 0}
        ></div>
    )
}

Switch.propTypes = {
    value: PropTypes.bool,
    defaultValue: PropTypes.bool,
    onChange: PropTypes.func,
    disabled: PropTypes.bool,
    className: PropTypes.string,
    ariaLabel: PropTypes.string,
}
export default Switch
