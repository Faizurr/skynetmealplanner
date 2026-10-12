package com.attendance.kiosk.core.flow

sealed interface PinValidation {
    data class Valid(val staffId: String, val pin: String) : PinValidation
    data class Invalid(val message: String) : PinValidation
}

/** Client-side checks matching the server schema (staff_id ≤ 32 chars, PIN 4–8 digits). */
object PinValidator {
    private val PIN = Regex("^\\d{4,8}$")

    fun validate(staffIdInput: String, pinInput: String): PinValidation {
        val staffId = staffIdInput.trim()
        if (staffId.isEmpty()) return PinValidation.Invalid("Enter your staff ID.")
        if (staffId.length > 32) return PinValidation.Invalid("That staff ID is too long.")
        if (!PIN.matches(pinInput)) return PinValidation.Invalid("Your PIN is 4 to 8 digits.")
        return PinValidation.Valid(staffId, pinInput)
    }
}
