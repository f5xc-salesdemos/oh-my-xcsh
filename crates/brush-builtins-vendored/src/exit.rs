use clap::Parser;

use brush_core::{ExecutionControlFlow, ExecutionResult, builtins};

/// Exit the shell.
#[derive(Parser)]
pub(crate) struct ExitCommand {
	/// The exit code to return.
	code: Option<i32>,
}

impl builtins::Command for ExitCommand {
	type Error = brush_core::Error;

	fn execute(
		&self,
		context: brush_core::ExecutionContext<'_>,
	) -> impl Future<Output = Result<brush_core::ExecutionResult, Self::Error>> {
		futures::future::lazy(move |_| {
			#[expect(clippy::cast_sign_loss)]
			let code_8bit = if let Some(code_32bit) = &self.code {
				(code_32bit & 0xFF) as u8
			} else {
				context.shell.last_result()
			};

			let mut result = ExecutionResult::new(code_8bit);
			result.next_control_flow = ExecutionControlFlow::ExitShell;

			Ok(result)
		})
	}
}
