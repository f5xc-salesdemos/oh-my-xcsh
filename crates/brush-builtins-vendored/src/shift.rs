use clap::Parser;

use brush_core::{ExecutionExitCode, ExecutionResult, builtins};

/// Shift positional arguments.
#[derive(Parser)]
pub(crate) struct ShiftCommand {
	/// Number of positions to shift the arguments by (defaults to 1).
	n: Option<i32>,
}

impl builtins::Command for ShiftCommand {
	type Error = brush_core::Error;

	fn execute(
		&self,
		context: brush_core::ExecutionContext<'_>,
	) -> impl Future<Output = Result<brush_core::ExecutionResult, Self::Error>> {
		futures::future::lazy(move |_| {
			let n = self.n.unwrap_or(1);

			if n < 0 {
				return Ok(ExecutionExitCode::InvalidUsage.into());
			}

			#[expect(clippy::cast_sign_loss)]
			let n = n as usize;

			if n > context.shell.positional_parameters.len() {
				return Ok(ExecutionExitCode::InvalidUsage.into());
			}

			context.shell.positional_parameters.drain(0..n);

			Ok(ExecutionResult::success())
		})
	}
}
