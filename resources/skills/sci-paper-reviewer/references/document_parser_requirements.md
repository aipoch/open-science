# SCI Paper Reviewer - Document Parser Dependencies

This file lists the required dependencies for the document parser functionality.

## Required Python Packages

For basic functionality (included in standard library):
- json
- logging
- pathlib
- sys
- os
- typing

For enhanced PDF parsing (optional but recommended):
- PyPDF2>=3.0.0
- pdfplumber>=0.9.0
- pymupdf>=1.23.0

For enhanced Word document parsing (optional but recommended):
- python-docx>=1.1.0

## Installation

### Basic Installation (required)
No additional packages needed - uses only Python standard library.

### Enhanced Installation (recommended)
```bash
pip install PyPDF2 pdfplumber pymupdf python-docx
```

## Usage Notes

1. **Basic Mode**: The parser works out-of-the-box with placeholder implementations
2. **Enhanced Mode**: Install recommended packages for full functionality
3. **Fallback Strategy**: If enhanced libraries are not available, the parser will use basic text extraction

## Production Deployment

For production use, it is recommended to install all enhanced dependencies:
```bash
pip install -r requirements.txt
```

Where requirements.txt contains:
```
PyPDF2>=3.0.0
pdfplumber>=0.9.0
pymupdf>=1.23.0
python-docx>=1.1.0
```