import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, describe } from 'vitest'
import App from './App'

afterEach(() => {
  cleanup()
})

describe('Deposit Defender App', () => {
  test('renders setup screen after loading', async () => {
    render(<App />)
    expect(await screen.findByText('House Record')).toBeInTheDocument()
    expect(screen.getByText('공간 구성')).toBeInTheDocument()
  })

  test('renders room configuration controls', async () => {
    render(<App />)
    expect(await screen.findByText('방')).toBeInTheDocument()
    expect(screen.getByText('화장실')).toBeInTheDocument()
    expect(screen.getByText('부엌')).toBeInTheDocument()
    expect(screen.getByText('거실')).toBeInTheDocument()
  })
})
