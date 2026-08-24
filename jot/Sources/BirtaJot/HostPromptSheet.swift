import AppKit
import BirtaJotCore

/// How Birta Writer for Mac draws one step of a flow the page is driving
/// (MAR-395).
///
/// A sheet on the window that asked, because that is what a modal question is
/// on this platform: it belongs to the note it was asked from, it does not
/// take the whole app, and it cannot be lost behind another window. VS Code
/// draws the same step as the palette prompts it already draws. Neither
/// surface owns the question.
///
/// It reports EXACTLY once, whether the user answered or cancelled, and that
/// is the rule the whole seam rests on: the page holds a pending request keyed
/// by id and a sheet that closed without saying so would leave the flow
/// waiting on a question that is gone. `DatePickerPopover` states the same
/// contract for the same reason, and `finish` here is its `finish`.
enum HostPromptSheet {
    /// Ask one step and report the answer, or nil for a cancel.
    static func present(_ step: HostPromptStep, on window: NSWindow,
                        answer: @escaping (String?) -> Void) {
        switch step {
        case let .input(title, prompt, placeholder, required, maxLength):
            presentInput(title: title, prompt: prompt, placeholder: placeholder,
                         required: required, maxLength: maxLength,
                         on: window, answer: answer)
        case let .pick(title, placeholder, rows):
            presentPick(title: title, placeholder: placeholder, rows: rows,
                        on: window, answer: answer)
        }
    }

    // MARK: - Free text

    private static func presentInput(
        title: String, prompt: String, placeholder: String?,
        required: String?, maxLength: HostPromptStep.MaxLength?,
        on window: NSWindow, answer: @escaping (String?) -> Void
    ) {
        // One field, reused, so an answer a rule refused is edited rather than
        // retyped. A FRESH `NSAlert` per attempt, because an alert is built to
        // be run once and re-presenting a dismissed one is not something
        // AppKit promises; a second presentation that quietly did nothing
        // would leave the page waiting out its whole timeout on a question
        // nobody can see. Building another costs nothing and asks no favours.
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.placeholderString = placeholder

        var reported = false
        let finish: (String?) -> Void = { value in
            guard !reported else { return }
            reported = true
            answer(value)
        }

        // Validation is the PAGE's rule, run here so a refusal is caught before
        // the sheet closes rather than after: `HostPromptStep.validate` is a
        // reading of `validateHostPromptInput`, so both surfaces refuse the
        // same answers with the same words. Where VS Code validates on every
        // keystroke and this validates on Continue, the difference is in when
        // the sentence appears, never in which answers are accepted.
        func ask(saying message: String?) {
            let alert = NSAlert()
            alert.messageText = title
            alert.informativeText = message.map { "\(prompt)\n\n\($0)" } ?? prompt
            alert.accessoryView = field
            // Without this the sheet opens with the default button focused and
            // the first keystroke submits an empty answer.
            alert.window.initialFirstResponder = field
            alert.addButton(withTitle: "Continue")
            let cancel = alert.addButton(withTitle: "Cancel")
            cancel.keyEquivalent = "\u{1b}"

            alert.beginSheetModal(for: window) { response in
                guard response == .alertFirstButtonReturn else {
                    finish(nil)
                    return
                }
                let value = field.stringValue
                if let refusal = HostPromptStep.validate(value, required: required,
                                                         maxLength: maxLength) {
                    // A turn of the run loop, so the sheet that is closing is
                    // gone before the next one is begun on the same window.
                    DispatchQueue.main.async { ask(saying: refusal) }
                    return
                }
                finish(value)
            }
        }
        ask(saying: nil)
    }

    // MARK: - A choice between rows

    private static func presentPick(
        title: String, placeholder: String?, rows: [HostPromptStep.Row],
        on window: NSWindow, answer: @escaping (String?) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = placeholder ?? ""

        // A pop-up rather than a button per row. `NSAlert` lays its buttons out
        // in one row, so four destinations each carrying a sentence of detail
        // would not fit and would lose the detail, which is the part that makes
        // the destination step a real question rather than a preference toll.
        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 360, height: 25))
        for row in rows {
            popup.addItem(withTitle: row.label)
            // The detail is the second line the palette draws under the label.
            // A menu item has one line, so it goes in the tooltip and, for the
            // selected row, under the pop-up where it is read without hovering.
            popup.lastItem?.toolTip = row.detail
        }

        let detail = NSTextField(labelWithString: rows.first?.detail ?? "")
        detail.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        detail.textColor = .secondaryLabelColor
        detail.lineBreakMode = .byWordWrapping
        detail.preferredMaxLayoutWidth = 360

        let follower = DetailFollower(rows: rows, label: detail)
        popup.target = follower
        popup.action = #selector(DetailFollower.selectionChanged(_:))

        let stack = NSStackView(views: [popup, detail])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.frame = NSRect(x: 0, y: 0, width: 360,
                             height: popup.frame.height + 6 + max(detail.intrinsicContentSize.height, 16))
        alert.accessoryView = stack

        alert.addButton(withTitle: "Continue")
        let cancel = alert.addButton(withTitle: "Cancel")
        cancel.keyEquivalent = "\u{1b}"

        alert.beginSheetModal(for: window) { response in
            // The follower is retained until here and no longer: a pop-up's
            // `target` is unowned, so nothing else keeps it alive while the
            // sheet is up.
            withExtendedLifetime(follower) {
                guard response == .alertFirstButtonReturn,
                      rows.indices.contains(popup.indexOfSelectedItem) else {
                    answer(nil)
                    return
                }
                answer(rows[popup.indexOfSelectedItem].id)
            }
        }
    }

    /// Keeps the detail line under the pop-up describing the row now selected.
    private final class DetailFollower: NSObject {
        private let rows: [HostPromptStep.Row]
        private weak var label: NSTextField?

        init(rows: [HostPromptStep.Row], label: NSTextField) {
            self.rows = rows
            self.label = label
        }

        @objc func selectionChanged(_ sender: NSPopUpButton) {
            let index = sender.indexOfSelectedItem
            label?.stringValue = rows.indices.contains(index) ? (rows[index].detail ?? "") : ""
        }
    }
}
