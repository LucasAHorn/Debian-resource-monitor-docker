FROM debian:bookworm-slim

# Install VS Code tools, Python, Pip, venv, and Node.js (for JavaScript)
RUN apt-get update && apt-get install -y \
    git \
    curl \
    tar \
    ca-certificates \
    python3 \
    python3-pip \
    python3-venv \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user
RUN useradd -m -s /bin/bash sandboxuser

# Switch to the non-root user
USER sandboxuser
WORKDIR /workspace

# Create a virtual environment and set it in the PATH.
# This enforces that all pip installs happen safely inside this isolated venv,
# bypassing Debian's PEP-668 restrictions without requiring sudo.
ENV VIRTUAL_ENV=/home/sandboxuser/venv
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"