#!/usr/bin/env python3
"""
Abstract Summarizer - Condense academic papers into structured 250-word abstracts.

Usage:
    python main.py --input <paper.pdf|paper.txt> [--output <summary.txt>]
    python main.py --text "<paper content>" [--format structured|plain]
    python main.py --url <paper_url> [--output <summary.txt>]
"""

import argparse
import re
import sys
from pathlib import Path
from typing import Optional


def count_words(text: str) -> int:
    """Count words in text, handling academic formatting."""
    # Remove citations like [1], [2,3], (Author, 2020)
    cleaned = re.sub(r'\[\d+(?:,\s*\d+)*\]', '', text)
    cleaned = re.sub(r'\([^)]*\d{4}[^)]*\)', '', cleaned)
    # Remove extra whitespace
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    # Count words
    return len(cleaned.split())


def extract_sections(text: str) -> dict:
    """
    Extract key sections from academic paper.
    Returns dict with identified sections.
    """
    sections = {
        'background': '',
        'objective': '',
        'methods': '',
        'results': '',
        'conclusion': ''
    }
    
    # Common section headers in academic papers
    section_patterns = {
        'abstract': r'(?:abstract|summary)[\s:]*\n',
        'introduction': r'(?:introduction|background)[\s:]*\n',
        'methods': r'(?:methods?|methodology|materials?\s+and\s+methods?|experimental)[\s:]*\n',
        'results': r'(?:results?|findings)[\s:]*\n',
        'discussion': r'(?:discussion)[\s:]*\n',
        'conclusion': r'(?:conclusion|concluding\s+remarks)[\s:]*\n'
    }
    
    # Find section positions
    section_positions = {}
    for section_name, pattern in section_patterns.items():
        matches = list(re.finditer(pattern, text, re.IGNORECASE))
        if matches:
            section_positions[section_name] = matches[0].start()
    
    # Sort sections by position
    sorted_sections = sorted(section_positions.items(), key=lambda x: x[1])
    
    # Extract content between sections
    for i, (section_name, start_pos) in enumerate(sorted_sections):
        end_pos = sorted_sections[i + 1][1] if i + 1 < len(sorted_sections) else len(text)
        content = text[start_pos:end_pos].strip()
        # Remove the header itself
        content = re.sub(section_patterns[section_name], '', content, flags=re.IGNORECASE).strip()
        sections[section_name] = content
    
    return sections


def extract_key_sentences(text: str, num_sentences: int = 3) -> list:
    """
    Extract most informative sentences using heuristics.
    """
    # Split into sentences (basic handling)
    sentences = re.split(r'(?<=[.!?])\s+', text)
    sentences = [s.strip() for s in sentences if len(s.strip()) > 20]
    
    if len(sentences) <= num_sentences:
        return sentences
    
    # Score sentences based on indicators of importance
    scored_sentences = []
    for sentence in sentences:
        score = 0
        
        # Indicators of key information
        indicators = [
            r'\b(?:propose|present|introduce|develop)\b',
            r'\b(?:result|finding|demonstrate|show|reveal|indicate)\b',
            r'\b(?:significant|substantial|considerable|notable)\b',
            r'\b(?:improve|enhance|increase|decrease|reduce)\b',
            r'\d+\.?\d*%',  # Percentages
            r'\b(?:p\s*<\s*0\.\d+)',  # Statistical significance
            r'\b(?:conclude|suggest|implication)\b'
        ]
        
        for indicator in indicators:
            if re.search(indicator, sentence, re.IGNORECASE):
                score += 1
        
        # Prefer sentences in certain positions (first and last of paragraphs often have key info)
        position_bonus = 0
        sentence_idx = sentences.index(sentence)
        if sentence_idx == 0 or sentence_idx == len(sentences) - 1:
            position_bonus = 0.5
        
        scored_sentences.append((sentence, score + position_bonus))
    
    # Sort by score and return top sentences
    scored_sentences.sort(key=lambda x: x[1], reverse=True)
    return [s[0] for s in scored_sentences[:num_sentences]]


def extract_quantitative_results(text: str) -> str:
    """
    Extract key quantitative findings.
    """
    patterns = [
        r'\b\d+(?:\.\d+)?\s*%\s*(?:increase|decrease|improvement|reduction|enhancement)',
        r'\b(?:accuracy|precision|recall|f1|score)\s*(?:of|reached|achieved|=)\s*\d+(?:\.\d+)?',
        r'\b(?:p\s*<\s*0\.\d+)\b',
        r'\b\d+(?:\.\d+)?\s*(?:fold|times|x)\s*(?:faster|slower|better|improved)',
        r'\b(?:outperformed|surpassed|exceeded)\s+.*?by\s+\d+(?:\.\d+)?\s*%'
    ]
    
    findings = []
    for pattern in patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        findings.extend(matches)
    
    return '; '.join(findings[:3]) if findings else ''


def generate_structured_abstract(text: str) -> str:
    """
    Generate a structured abstract from paper text.
    """
    sections = extract_sections(text)
    
    # Extract abstract if available
    abstract_text = sections.get('abstract', text[:2000])  # Use first 2000 chars if no abstract
    
    # Background - from introduction or first part of abstract
    intro_text = sections.get('introduction', abstract_text[:500])
    background_sentences = extract_key_sentences(intro_text, 1)
    background = background_sentences[0] if background_sentences else ""
    
    # Objective - look for purpose statements
    objective_patterns = [
        r'(?:aim|objective|purpose|goal|this\s+study|this\s+paper|this\s+research)\s*(?:is\s+to|was\s+to|to|:\s*)([^.]+)',
        r'(?:we\s+(?:aim|seek|intend)\s+to)([^.]+)',
        r'(?:investigate|examine|explore|analyze|assess)([^.]+)'
    ]
    
    objective = ""
    for pattern in objective_patterns:
        match = re.search(pattern, abstract_text, re.IGNORECASE)
        if match:
            objective = match.group(0).strip()
            break
    
    if not objective:
        obj_sentences = [s for s in extract_key_sentences(abstract_text, 3) 
                        if any(word in s.lower() for word in ['aim', 'objective', 'purpose', 'investigate', 'examine'])]
        if obj_sentences:
            objective = obj_sentences[0]
    
    # Methods
    methods_text = sections.get('methods', '')
    if methods_text:
        method_sentences = extract_key_sentences(methods_text, 2)
        methods = ' '.join(method_sentences)
    else:
        # Try to extract from abstract
        method_indicators = r'(?:using|by|via|through|with|based\s+on)\s+(?:a\s+)?(?:novel|new|proposed|developed)?\s*([^,.]+(?:algorithm|method|approach|model|framework|technique|system))'
        match = re.search(method_indicators, abstract_text, re.IGNORECASE)
        methods = match.group(0) if match else "The study employed established methodologies."
    
    # Results
    results_text = sections.get('results', '')
    quantitative = extract_quantitative_results(results_text or abstract_text)
    
    if results_text:
        result_sentences = extract_key_sentences(results_text, 2)
        results = ' '.join(result_sentences)
    else:
        result_sentences = [s for s in extract_key_sentences(abstract_text, 5)
                           if any(word in s.lower() for word in ['result', 'found', 'showed', 'demonstrated', 'achieved'])]
        results = ' '.join(result_sentences[:2]) if result_sentences else "Key findings are presented."
    
    if quantitative and quantitative not in results:
        results += f" Quantitative results: {quantitative}."
    
    # Conclusion
    conclusion_text = sections.get('conclusion', sections.get('discussion', ''))
    if conclusion_text:
        conclusion_sentences = extract_key_sentences(conclusion_text, 1)
        conclusion = conclusion_sentences[0] if conclusion_sentences else ""
    else:
        conclusion_sentences = [s for s in extract_key_sentences(abstract_text, 5)
                               if any(word in s.lower() for word in ['conclude', 'suggest', 'indicate', 'implication', 'future'])]
        conclusion = conclusion_sentences[0] if conclusion_sentences else "Implications of the findings are discussed."
    
    # Assemble structured abstract
    structured = []
    
    if background:
        structured.append(f"**Background**: {background}")
    if objective:
        structured.append(f"**Objective**: {objective}")
    if methods:
        structured.append(f"**Methods**: {methods}")
    if results:
        structured.append(f"**Results**: {results}")
    if conclusion:
        structured.append(f"**Conclusion**: {conclusion}")
    
    abstract_text = '\n\n'.join(structured)
    word_count = count_words(abstract_text)
    
    # Trim if over limit
    while word_count > 250:
        # Remove least important sentence from results
        result_section = [s for s in structured if s.startswith('**Results**:')]
        if result_section:
            sentences = re.split(r'(?<=[.!?])\s+', result_section[0].replace('**Results**: ', ''))
            if len(sentences) > 1:
                trimmed = ' '.join(sentences[:-1])
                structured = [s if not s.startswith('**Results**:') else f"**Results**: {trimmed}" for s in structured]
        
        abstract_text = '\n\n'.join(structured)
        new_count = count_words(abstract_text)
        if new_count == word_count:  # No progress, break
            break
        word_count = new_count
    
    abstract_text += f"\n\n---\nWord count: {word_count}/250"
    
    return abstract_text


def read_file(filepath: str) -> str:
    """Read content from file."""
    path = Path(filepath)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {filepath}")
    
    # Handle PDF (basic text extraction)
    if path.suffix.lower() == '.pdf':
        try:
            import PyPDF2
            with open(path, 'rb') as f:
                reader = PyPDF2.PdfReader(f)
                text = ''
                for page in reader.pages:
                    text += page.extract_text() + '\n'
                return text
        except ImportError:
            raise ImportError("PyPDF2 required for PDF processing. Install with: pip install PyPDF2")
    
    # Handle text files
    with open(path, 'r', encoding='utf-8', errors='ignore') as f:
        return f.read()


def main():
    parser = argparse.ArgumentParser(
        description='Summarize academic papers into 250-word structured abstracts'
    )
    parser.add_argument('--input', '-i', help='Input file path (PDF or TXT)')
    parser.add_argument('--text', '-t', help='Direct text input')
    parser.add_argument('--url', '-u', help='URL to fetch paper from')
    parser.add_argument('--output', '-o', help='Output file path')
    parser.add_argument('--format', '-f', choices=['structured', 'plain'], 
                       default='structured', help='Output format')
    
    args = parser.parse_args()
    
    # Get input text
    if args.input:
        text = read_file(args.input)
    elif args.text:
        text = args.text
    elif args.url:
        try:
            import requests
            response = requests.get(args.url, timeout=30)
            response.raise_for_status()
            text = response.text
        except ImportError:
            print("Error: requests library required for URL fetching", file=sys.stderr)
            sys.exit(1)
        except Exception as e:
            print(f"Error fetching URL: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        # Read from stdin
        text = sys.stdin.read()
    
    if not text or not text.strip():
        print("Error: No input provided", file=sys.stderr)
        sys.exit(1)
    
    # Generate abstract
    abstract = generate_structured_abstract(text)
    
    # Output
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(abstract)
        print(f"Abstract written to: {args.output}")
    else:
        print(abstract)


if __name__ == '__main__':
    main()
